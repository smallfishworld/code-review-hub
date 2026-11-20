import { mkdirSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import type { LogService } from '../logs/logService.js';
import { OcrRunner, workCopyDir } from '../tasks/ocrRunner.js';
import { svnUpdate, svnInfo, runSvn } from '../vcs/svn.js';
import { runGit, gitClone, gitFetchBranch, gitPrepareCommit, gitResolveSha } from '../vcs/git.js';
import {
  buildOcrConfig,
  prepareOcrHomeSvnConfig,
  resolveProvider,
  type OcrConfigFile,
} from '../providers/ocrProviderConfig.js';
import { parseOcrReport } from '../tasks/reportService.js';
import { probeDependency } from '../deps/detector.js';
import { locateCommand } from '../deps/which.js';
import { runCapture } from '../providers/providerTester.js';
import type {
  EngineCapabilities,
  EngineProbe,
  EngineRawResult,
  NormalizedIssue,
  PrepareContext,
  PrepareResult,
  ReviewEngine,
  ReviewRequest,
} from './types.js';

/**
 * The `ocr` CLI as the first ReviewEngine adapter (openspec D4).
 *
 * Process plumbing (spawn/kill/timeout/heartbeat) is REUSED from the shipped
 * tasks/ocrRunner.ts (`runOcr` is public); this adapter adds the engine
 * semantics on top:
 * - HOME is isolated PER REPO (`<dataDir>/ocr-home/<repo-id>/`) instead of
 *   shared: MCP injection makes the generated config.json task-dependent, and
 *   the queue runs up to two repos concurrently — a shared home would let one
 *   task overwrite another's MCP config (or leak servers across repos). Same
 *   repo tasks stay serial (queue guarantee) and reuse their home.
 * - probe() gates runtime features: ocr < 1.13 skips MCP config injection and
 *   `--requirement` memory injection (review continues without them).
 * - prepare() also collects the change set (files + sampled identifiers) as
 *   the retrieval input for project memory.
 */

/** Per-repo isolated HOME for the ocr child process. */
export function ocrHomeDir(dataDir: string, repoId: number): string {
  return join(dataDir, 'ocr-home', String(repoId));
}

/** Features that require ocr >= 1.13. */
const VERSION_GATED = ['mcp', 'memory'];

/** Compare dotted version strings; missing segments count as 0. */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Validate the revision/commit argument before it reaches a CLI arg vector.
 * SVN nodes are bare revision numbers; git nodes are hex SHAs (4-40 chars).
 * Task nodes are validated upstream too — this is the last line of defense
 * so no value starting with '-' can ever be parsed as an option by ocr.
 */
export function validatedNode(vcs: 'svn' | 'git', node: string): string {
  if (vcs === 'svn' && /^\d+$/.test(node)) return node;
  if (vcs === 'git' && /^[0-9a-fA-F]{4,40}$/.test(node)) return node;
  throw new Error(`非法的评审节点: ${node.slice(0, 40)}`);
}

export interface OcrEngineOptions {
  dataDir: string;
  ocrBin?: string;
  taskTimeoutMs?: number;
  logs?: LogService;
}

export class OcrEngine implements ReviewEngine {
  readonly engineId: number;
  readonly name: string;
  readonly capabilities: EngineCapabilities = {
    vcs: ['svn', 'git'],
    revisionMode: 'single',
    fullFileScan: true,
    mcp: 'config-inject',
    memoryInjection: 'requirement',
    resume: false,
    streaming: false,
    minVersion: '1.13.0',
  };

  private degraded: string[] = [];
  private readonly runner: OcrRunner;

  constructor(
    engineId: number,
    name: string,
    private readonly db: Database.Database,
    private readonly credentials: CredentialService,
    private readonly opts: OcrEngineOptions
  ) {
    this.engineId = engineId;
    this.name = name;
    this.runner = new OcrRunner(db, credentials, {
      dataDir: opts.dataDir,
      ocrBin: opts.ocrBin,
      taskTimeoutMs: opts.taskTimeoutMs,
      logs: opts.logs,
    });
  }

  /** Resolve the ocr binary + version; gate MCP/memory on observed support. */
  async probe(): Promise<EngineProbe> {
    // Reuse the shipped dependency probe (deps/detector.ts) — it resolves the
    // binary via which() and runs `ocr --version` safely.
    const dep = await probeDependency('ocr', false, 10_000);
    if (!dep.found || !dep.executable) {
      this.degraded = [];
      return { ok: false, degraded: [], version: dep.version, error: dep.error };
    }
    this.degraded = [];
    const version = dep.version?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? dep.version;
    if (version && compareVersion(version, this.capabilities.minVersion ?? '0.0.0') < 0) {
      this.degraded = [...VERSION_GATED];
    }
    // Runtime capability check: memory injection needs `--background-file`
    // (1.13.x exposes requirement context as --background / --background-file,
    // NOT --requirement). Probe the review help text empirically.
    try {
      const located = await locateCommand('ocr');
      if (located.path) {
        const help = await runCapture(located.path, ['review', '--help'], {
          env: process.env as Record<string, string>,
          timeoutMs: 15_000,
        });
        if (!help.output.includes('--background-file')) {
          if (!this.degraded.includes('memory')) this.degraded.push('memory');
        }
      }
    } catch {
      // help probe failed: keep version-based gating only
    }
    return { ok: true, degraded: [...this.degraded], version };
  }

  /** Prepare the working copy at the task node + collect the change set. */
  async prepare(ctx: PrepareContext): Promise<PrepareResult> {
    mkdirSync(join(this.opts.dataDir, 'reports'), { recursive: true });
    const repoId = ctx.task.repoId;
    const home = ocrHomeDir(this.opts.dataDir, repoId);
    // The ocr HOME must exist BEFORE the SVN credential-seeding checkout so
    // svn writes into the store the ocr child will read (see
    // prepareOcrHomeSvnConfig). Git has no HOME dependency.
    prepareOcrHomeSvnConfig(home);
    const homeEnv = { HOME: home, USERPROFILE: home };

    try {
      if (ctx.auth.type === 'svn') {
        this.opts.logs?.info('task', `#${ctx.task.id} 同步 SVN 工作副本到 r${ctx.task.node}…`);
        await this.prepareSvnWorkCopy(ctx, homeEnv);
      } else {
        this.opts.logs?.info('task', `#${ctx.task.id} 同步 Git 仓库到 ${ctx.task.node.slice(0, 10)}…`);
        await this.prepareGitClone(ctx);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logs?.error('task', `#${ctx.task.id} 工作副本准备失败: ${reason}`);
      throw new Error(`工作副本准备失败: ${reason}`, { cause: err });
    }

    try {
      return await this.collectChanges(ctx, homeEnv);
    } catch (err) {
      // Memory retrieval input is best-effort: never fail the review over it.
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logs?.info(
        'task',
        `#${ctx.task.id} 变更文件采集失败（记忆检索降级为全文匹配）: ${reason}`
      );
      return { changedFiles: [], identifiers: [] };
    }
  }

  /** Changed files + identifier sampling for the reviewed node. */
  private async collectChanges(
    ctx: PrepareContext,
    homeEnv: Record<string, string>
  ): Promise<PrepareResult> {
    const wcDir = workCopyDir(this.opts.dataDir, ctx.task.repoId);
    // svn diff --summarize prints ABSOLUTE paths when given an absolute
    // target; memory scope matching expects wc-relative paths, so normalize
    // everything (git diff-tree already prints repo-relative).
    const normalize = (p: string): string => {
      const norm = p.replace(/\\/g, '/').replace(/^[AMDR?!\s]+\s*/, '').trim();
      const wcPrefix = wcDir.replace(/\\/g, '/') + '/';
      return norm.startsWith(wcPrefix) ? norm.slice(wcPrefix.length) : norm;
    };
    if (ctx.auth.type === 'svn') {
      const rev = validatedNode('svn', ctx.task.node);
      const out = await runSvn(
        ['diff', '--summarize', '--change', rev, wcDir],
        { username: ctx.auth.username, password: ctx.auth.password },
        { timeoutMs: 2 * 60_000, env: homeEnv }
      );
      const files = out.stdout
        .split(/\r?\n/)
        .map(normalize)
        .filter((l) => l.length > 0);
      return { changedFiles: files, identifiers: sampleIdentifiers(files, []) };
    }
    // Git: files of the commit; identifiers sampled from added diff lines.
    const full = validatedNode('git', (await gitResolveSha(wcDir, ctx.task.node)) ?? ctx.task.node);
    const filesOut = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', full], {
      cwd: wcDir,
      timeoutMs: 2 * 60_000,
    });
    const files = filesOut.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let addedLines: string[] = [];
    try {
      const diff = await runGit(['diff', '-U0', `${full}^`, full], {
        cwd: wcDir,
        timeoutMs: 2 * 60_000,
      });
      addedLines = diff.stdout.split(/\r?\n/).filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    } catch {
      // root commit has no parent: identifiers fall back to file names
    }
    return { changedFiles: files, identifiers: sampleIdentifiers(files, addedLines) };
  }

  /** Bootstrap + update the SVN working copy to the task revision. */
  private async prepareSvnWorkCopy(
    ctx: PrepareContext,
    homeEnv: Record<string, string>
  ): Promise<void> {
    const task = ctx.task;
    const wcDir = workCopyDir(this.opts.dataDir, task.repoId);
    const svnAuth = { username: ctx.auth.username, password: ctx.auth.password };
    if (!existsSync(join(wcDir, '.svn'))) {
      mkdirSync(wcDir, { recursive: true });
      // Full checkout: ocr reviews complete files ("Full-File Scan" — it
      // reads surrounding code via `svn cat`, not just the diff), so the
      // working copy must contain the whole tree.
      //
      // cacheAuth=true: the only server-touching call under the ocr HOME —
      // svn writes credentials to its store ONLY during an authenticated
      // server exchange; ocr's own svn calls run with NO auth flags under the
      // same redirected HOME and would hang forever on an invisible auth
      // prompt without a seeded store.
      await runSvn(['checkout', ctx.auth.url, wcDir], svnAuth, {
        onSpawn: (c) => ctx.onSpawn({ kill: () => c.kill() }),
        timeoutMs: 30 * 60_000,
        cacheAuth: true,
        env: homeEnv,
      });
      await svnInfo(wcDir, svnAuth);
    }
    const rev = validatedNode('svn', task.node);
    await svnUpdate(wcDir, Number(rev), svnAuth, {
      onSpawn: (c) => ctx.onSpawn({ kill: () => c.kill() }),
    });
  }

  /** Bootstrap + fetch + checkout the git clone at the task commit. */
  private async prepareGitClone(ctx: PrepareContext): Promise<void> {
    const task = ctx.task;
    const wcDir = workCopyDir(this.opts.dataDir, task.repoId);
    const auth = { username: ctx.auth.username, password: ctx.auth.password };
    if (!existsSync(join(wcDir, '.git'))) {
      mkdirSync(join(wcDir, '..'), { recursive: true });
      await gitClone(ctx.auth.url, wcDir, auth);
    }
    await gitFetchBranch(wcDir, ctx.auth.url, ctx.auth.branch ?? 'main', auth);
    // node may be a short sha; resolve via the local repo
    const full = (await gitResolveSha(wcDir, task.node)) ?? task.node;
    await gitPrepareCommit(wcDir, ctx.auth.url, full, auth);
  }

  /** Execute one ocr review run; returns the report path on success. */
  async review(req: ReviewRequest, ctx: PrepareContext): Promise<EngineRawResult & { reportPath?: string }> {
    const commit = validatedNode(ctx.auth.type, ctx.task.node);
    const wcDir = workCopyDir(this.opts.dataDir, ctx.task.repoId);
    const reportPath = join(this.opts.dataDir, 'reports', `${ctx.task.id}.json`);
    const args = [
      'review',
      '--repo',
      wcDir,
      '--commit',
      commit,
      '--format',
      'json',
      '--output',
      reportPath,
    ];

    // Memory context (skipped when unsupported): real ocr 1.13.x exposes
    // requirement context as `--background-file <md>` — prefer the file form
    // (no command-line length/escaping issues) and fall back to inline
    // `--background <text>` when the file form is unavailable.
    const useRequirement = Boolean(req.requirementText) && !this.degraded.includes('memory');
    let tmpDir: string | null = null;
    if (useRequirement) {
      tmpDir = mkdtempSync(join(tmpdir(), 'crp-req-'));
      const file = join(tmpDir, 'background.md');
      writeFileSync(file, req.requirementText!, 'utf8');
      args.push('--background-file', file);
    }

    try {
      const result = await this.runOcrWithConfig(args, ctx, req.mcpServers ?? null);
      if (result.exitCode === 0 || !useRequirement) return result;
      // File form unsupported -> retry once with inline text (design D4).
      const inlineArgs = args.slice(0, -2);
      inlineArgs.push('--background', req.requirementText!.slice(0, 6000));
      const retry = await this.runOcrWithConfig(inlineArgs, ctx, req.mcpServers ?? null);
      return retry.exitCode === 0 ? retry : result;
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * One runOcr invocation with the per-repo HOME config written just before
   * the process starts (provider + MCP servers). Home is repo-scoped: config
   * is task-dependent and repos run concurrently (see class doc).
   */
  private async runOcrWithConfig(
    args: string[],
    ctx: PrepareContext,
    mcpServers: Record<string, unknown> | null
  ): Promise<EngineRawResult & { reportPath?: string }> {
    const task = ctx.task;
    const home = ocrHomeDir(this.opts.dataDir, task.repoId);
    this.writeHomeConfig(home, mcpServers);
    const env = { HOME: home, USERPROFILE: home };
    return this.runner.runOcr(args, task.id, ctx.onSpawn, env);
  }

  /**
   * Write the isolated ocr config.json for this task: the configured LLM
   * provider (when any) plus the repo's MCP servers (when the engine is not
   * version-degraded). Equivalent to prepareOcrHome + mcp_servers extension.
   */
  private writeHomeConfig(home: string, mcpServers: Record<string, unknown> | null): void {
    const provider = resolveProvider(this.db, this.credentials);
    const config: OcrConfigFile & { mcp_servers?: Record<string, unknown> } = provider
      ? buildOcrConfig(provider)
      : {};
    if (mcpServers && !this.degraded.includes('mcp')) {
      config.mcp_servers = mcpServers;
    }
    const configDir = join(home, '.opencodereview');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    prepareOcrHomeSvnConfig(home);
  }

  /** Map ocr's native JSON to the unified issue model (tolerant per item). */
  normalize(raw: string): { issues: NormalizedIssue[] } {
    let parsed;
    try {
      parsed = parseOcrReport(raw);
    } catch {
      return { issues: [] };
    }
    return {
      issues: parsed.comments.map((c) => ({
        file: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        severity: c.severity,
        category: c.category,
        description: c.content ?? '',
        suggestion: c.suggestion,
      })),
    };
  }
}

/** Identifier sampling: path segments + names + tokens from added lines. */
export function sampleIdentifiers(files: string[], addedLines: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    for (const seg of norm.split('/')) {
      if (seg && seg !== '.' && seg !== '..') out.add(seg);
    }
    const base = norm.split('/').pop() ?? '';
    const stem = base.replace(/\.[^.]+$/, '');
    if (stem.length >= 3) out.add(stem);
  }
  const identRe = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
  for (const line of addedLines.slice(0, 800)) {
    const matches = line.match(identRe);
    if (matches) for (const m of matches.slice(0, 10)) out.add(m);
  }
  return [...out].slice(0, 200);
}