import { spawn } from 'node:child_process';
import type { TaskRecord } from './taskQueue.js';
import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import { svnUpdate, svnInfo } from '../vcs/svn.js';
import { gitClone, gitFetchBranch, gitPrepareCommit, injectCredentialsInUrl } from '../vcs/git.js';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { prepareOcrHome, resolveProvider } from '../providers/ocrProviderConfig.js';
import { which } from '../deps/which.js';
import type { LogService } from '../logs/logService.js';

/**
 * Executes review tasks by invoking the `ocr` CLI.
 *
 * Per task:
 * - SVN: `svn update -r <rev>` the repo's cached working copy (bootstrapped
 *   by an initial `svn checkout` on first use), then
 *   `ocr review --repo <wc> --commit <rev> --format json --output <file>`
 * - Git: `git fetch + checkout <sha>` the repo's cached clone (bootstrapped
 *   by `git clone` on first use), then
 *   `ocr review --repo <clone> --commit <sha> --format json --output <file>`
 *
 * ocr stderr and exit code are captured for the task's error field;
 * cancellation kills the child process.
 */

export interface OcrRunnerOptions {
  /** Base dir for working-copy/clone caches and reports. */
  dataDir: string;
  /** Path of the ocr executable (resolved via PATH by default). */
  ocrBin?: string;
  /** Per-task timeout (default 30 minutes). */
  taskTimeoutMs?: number;
  /** Runtime log sink (web console); ocr stdout/stderr lines land here. */
  logs?: LogService;
}

export interface OcrRunResult {
  exitCode: number;
  error?: string;
  reportPath?: string;
}

export interface RepoAuthInfo {
  type: 'svn' | 'git';
  url: string;
  username?: string;
  password?: string;
  branch?: string;
}

/**
 * Engine-boundary validation for admin-configured repo fields (policy:
 * securityInvariants). URLs must carry a known VCS protocol or be absolute
 * filesystem paths (local repos are a supported use case), and must contain
 * no control characters (argv is shell-free, but the boundary check keeps
 * the taint chain observable and stops stray whitespace/NEWLINE tricks).
 */
const VCS_URL_RE = /^(?:file|http|https|svn|svn\+ssh|git|ssh):\/\/[\x21-\x7e]+$/;
const LOCAL_PATH_RE = /^(?:[A-Za-z]:)?[/\\][\x20-\x7e]+$/;
const SAFE_USERINFO_RE = /^[\x20-\x7e]{0,200}$/;

function assertSafeRepoAuth(auth: RepoAuthInfo): RepoAuthInfo {
  if (!VCS_URL_RE.test(auth.url) && !LOCAL_PATH_RE.test(auth.url)) {
    throw new Error(`仓库地址协议或格式不受支持: ${auth.url.slice(0, 60)}`);
  }
  for (const [label, value] of [
    ['username', auth.username],
    ['branch', auth.branch],
  ] as const) {
    if (value !== undefined && !SAFE_USERINFO_RE.test(value)) {
      throw new Error(`仓库${label}含非法字符`);
    }
  }
  return auth;
}

function loadRepoAuth(
  db: Database.Database,
  credentials: CredentialService,
  repoId: number
): RepoAuthInfo {
  const row = db
    .prepare('SELECT * FROM repo WHERE id = ?')
    .get(repoId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`repo ${repoId} not found`);
  return assertSafeRepoAuth({
    type: row.type as 'svn' | 'git',
    url: row.url as string,
    username: (row.username as string | null) ?? undefined,
    password: row.credential_id
      ? (credentials.reveal(row.credential_id as number) ?? undefined)
      : undefined,
    branch: (row.branch as string | null) ?? undefined,
  });
}

/** Directory holding the cached working copy / clone for a repo. */
export function workCopyDir(dataDir: string, repoId: number): string {
  return join(dataDir, 'workcopies', String(repoId));
}

export class OcrRunner {
  constructor(
    private readonly db: Database.Database,
    private readonly credentials: CredentialService,
    private readonly opts: OcrRunnerOptions
  ) {}

  /** Executor callback for TaskQueue. */
  executor = async (
    task: TaskRecord,
    onSpawn: (child: { kill: (signal?: string) => void }) => void
  ): Promise<{ exitCode: number; error?: string }> => {
    const auth = loadRepoAuth(this.db, this.credentials, task.repoId);
    const reportPath = join(this.opts.dataDir, 'reports', `${task.id}.json`);
    const result = await this.run(task, auth, reportPath, onSpawn);
    return { exitCode: result.exitCode, error: result.error };
  };

  /** One review run: prepare local copy, invoke ocr, capture output. */
  async run(
    task: TaskRecord,
    auth: RepoAuthInfo,
    reportPath: string,
    onSpawn: (child: { kill: (signal?: string) => void }) => void
  ): Promise<OcrRunResult> {
    // ensure reports dir exists
    mkdirSync(join(this.opts.dataDir, 'reports'), { recursive: true });

    // Resolve the provider/ocr home BEFORE workspace prep: the SVN credential
    // seeding below must write into the SAME home the ocr child will read
    // (svn caches credentials under HOME/.subversion on POSIX, APPDATA on
    // Windows — APPDATA is shared either way).
    const provider = resolveProvider(this.db, this.credentials);
    const ocrHome = prepareOcrHome(this.opts.dataDir, provider);

    try {
      if (auth.type === 'svn') {
        this.opts.logs?.info('task', `#${task.id} 同步 SVN 工作副本到 r${task.node}…`);
        await this.prepareSvnWorkCopy(task, auth, onSpawn, ocrHome?.env);
      } else {
        this.opts.logs?.info('task', `#${task.id} 同步 Git 仓库到 ${task.node.slice(0, 10)}…`);
        await this.prepareGitClone(task, auth, onSpawn);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logs?.error('task', `#${task.id} 工作副本准备失败: ${reason}`);
      return {
        exitCode: -1,
        error: `工作副本准备失败: ${reason}`,
      };
    }
    this.opts.logs?.info('task', `#${task.id} 工作副本就绪，启动 ocr 评审…`);

    const wcDir = workCopyDir(this.opts.dataDir, task.repoId);
    const args = [
      'review',
      '--repo',
      wcDir,
      '--commit',
      task.node,
      '--format',
      'json',
      '--output',
      reportPath,
    ];
    // Feed the configured LLM provider to ocr through an isolated HOME so the
    // platform's provider settings win over any global ocr config.
    return this.runOcr(args, task.id, onSpawn, ocrHome?.env);
  }

  /** Bootstrap + update the SVN working copy to the task revision. */
  private async prepareSvnWorkCopy(
    task: TaskRecord,
    auth: RepoAuthInfo,
    onSpawn: (child: { kill: (signal?: string) => void }) => void,
    envOverrides?: Record<string, string>
  ): Promise<void> {
    const wcDir = workCopyDir(this.opts.dataDir, task.repoId);
    const svnAuth = { username: auth.username, password: auth.password };
    if (!existsSync(join(wcDir, '.svn'))) {
      mkdirSync(wcDir, { recursive: true });
      // Full checkout: ocr reviews complete files ("Full-File Scan" — it
      // reads surrounding code via `svn cat`, not just the diff), so the
      // working copy must contain the whole tree. A sparse `--depth empty`
      // checkout forced one server round-trip per file read.
      //
      // cacheAuth=true: this is the only server-touching call under the ocr
      // HOME, and svn writes credentials to its store ONLY during an
      // authenticated server exchange (an `svn info <wc>` seed is local and
      // never stores). ocr's own svn calls run with NO auth flags under the
      // same redirected HOME — without a seeded store they hang forever on
      // an invisible auth prompt. envOverrides carries the ocr HOME (built
      // in run() before prep). Other platform svn calls stay --no-auth-cache.
      const { runSvn } = await import('../vcs/svn.js');
      await runSvn(
        ['checkout', auth.url, wcDir],
        svnAuth,
        {
          onSpawn: (c) => onSpawn({ kill: () => c.kill() }),
          timeoutMs: 30 * 60_000,
          cacheAuth: true,
          env: envOverrides,
        }
      );
      // verify reachable + get HEAD for sanity
      await svnInfo(wcDir, svnAuth);
    }
    // move the working copy to the task revision
    await svnUpdate(wcDir, Number(task.node), svnAuth, {
      onSpawn: (c) => onSpawn({ kill: () => c.kill() }),
    });
  }

  /** Bootstrap + fetch + checkout the git clone at the task commit. */
  private async prepareGitClone(
    task: TaskRecord,
    auth: RepoAuthInfo,
    _onSpawn: (child: { kill: (signal?: string) => void }) => void
  ): Promise<void> {
    const wcDir = workCopyDir(this.opts.dataDir, task.repoId);
    if (!existsSync(join(wcDir, '.git'))) {
      mkdirSync(join(wcDir, '..'), { recursive: true });
      await gitClone(auth.url, wcDir, {
        username: auth.username,
        password: auth.password,
      });
    }
    // fetch branch and check out the commit (sha passed in task.node)
    await gitFetchBranch(wcDir, auth.url, auth.branch ?? 'main', {
      username: auth.username,
      password: auth.password,
    });
    // node may be a short sha; resolve via the local repo
    const { gitResolveSha } = await import('../vcs/git.js');
    const full = (await gitResolveSha(wcDir, task.node)) ?? task.node;
    await gitPrepareCommit(wcDir, auth.url, full, {
      username: auth.username,
      password: auth.password,
    });
  }

  /** Stream one ocr output chunk into the runtime log, line by line. */
  private logOcrOutput(taskId: number, chunk: string, level: 'info' | 'error'): void {
    const logs = this.opts.logs;
    if (!logs) return;
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.trim();
      if (line) logs.log(level, 'ocr', `#${taskId} ${line}`);
    }
  }

  /**
   * Invoke ocr and wait; cancellation kills the process. Public since the
   * engine adapter (engines/ocrEngine.ts) reuses this process plumbing and
   * supplies its own args/env (per-repo HOME, --requirement, MCP config).
   */
  async runOcr(
    args: string[],
    taskId: number,
    onSpawn: (child: { kill: (signal?: string) => void }) => void,
    envOverrides?: Record<string, string>
  ): Promise<OcrRunResult> {
    // Resolve through PATH ourselves: on Windows a bare `ocr` would hit the
    // extensionless npm shim, which CreateProcess cannot execute. which()
    // prefers `ocr.cmd` (see deps/which.ts).
    const bin = this.opts.ocrBin ?? (await which('ocr')) ?? 'ocr';
    // Windows cannot spawn .cmd/.bat shims (npm's `ocr` is an .cmd) without
    // a shell. shell:true lets node quote the binary path correctly; args
    // are platform-constructed (no free-form user input reaches them —
    // task.node is validated as a revision number / commit sha upstream).
    // On POSIX no shell is used at all.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);

    return new Promise<OcrRunResult>((resolve) => {
      const child = spawn(bin, args, {
        windowsHide: true,
        shell: needsShell,
        // POSIX: put ocr in its own process group so cancellation can signal
        // the whole tree. npm's `ocr` shim is a shell script that execs the
        // real binary, but a fake/other wrapper may spawn children that keep
        // our stdout/stderr pipes open — killing only the leader would then
        // leave the task hanging until the child exits on its own.
        detached: process.platform !== 'win32',
        env: envOverrides
          ? { ...(process.env as Record<string, string>), ...envOverrides }
          : undefined,
      });
      // On Windows, killing a shell shim only kills cmd.exe — the actual
      // ocr (grandchild) keeps running. Kill the whole tree instead. The
      // PID travels via a sanitized environment variable (NOT the argv
      // vector — argv stays fully static), and PowerShell only ever
      // expands it as data into the fixed taskkill invocation.
      const killTree = () => {
        if (process.platform === 'win32') {
          const pid = child.pid;
          const pidToken =
            typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && /^\d+$/.test(String(pid))
              ? String(pid)
              : null;
          if (pidToken !== null) {
            spawn(
              'powershell',
              ['-NoProfile', '-Command', 'taskkill /PID $env:CRP_PID /T /F'],
              { windowsHide: true, env: { ...process.env, CRP_PID: pidToken } }
            );
          }
        } else if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill();
          }
        } else {
          child.kill();
        }
      };
      onSpawn({ kill: killTree });

      let stderr = '';
      let stdout = '';
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        stderr += text;
        if (stderr.length > 16_384) stderr = stderr.slice(-16_384);
        this.logOcrOutput(taskId, text, 'error');
      });
      child.stdout?.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        stdout += text;
        if (stdout.length > 16_384) stdout = stdout.slice(-16_384);
        this.logOcrOutput(taskId, text, 'info');
      });

      // Recorded so a killed run can say WHY it died instead of the
      // information-free "ocr 退出码 1" (taskkill /F surfaces as exit code 1).
      const timeoutMs = this.opts.taskTimeoutMs ?? 30 * 60_000;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);
      // Heartbeat: ocr can stay silent for many minutes (slow SVN diff, a long
      // LLM call) and an operator watching the runtime log cannot tell that
      // from a hung process. One line a minute until the first real output.
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        this.opts.logs?.info(
          'ocr',
          `#${taskId} 运行中… ${Math.round((Date.now() - startedAt) / 60_000)} 分钟（ocr 暂无输出）`
        );
      }, 60_000);

      child.on('error', (err) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        resolve({ exitCode: -1, error: `无法启动 ocr: ${err.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        if (code === 0) resolve({ exitCode: 0, reportPath: args[args.length - 1] });
        else
          resolve({
            exitCode: code ?? -1,
            error: describeOcrFailure(code, timedOut, timeoutMs, stderr, stdout),
          });
      });
    });
  }
}

export { loadRepoAuth, injectCredentialsInUrl };

/**
 * Build the task error for a non-zero ocr exit. ocr prints its real failure
 * reason on stderr (e.g. "Error: review failed: all 1 file review(s) failed —
 * check your LLM configuration and API key"), so stderr always wins. The
 * fallbacks cover the cases where stderr stays empty: a timeout kill (a
 * taskkill /F surfaces as exit code 1) and a hard crash with no output at all.
 */
function describeOcrFailure(
  code: number | null,
  timedOut: boolean,
  timeoutMs: number,
  stderr: string,
  stdout: string
): string {
  const minutes = Math.round(timeoutMs / 60_000);
  const errText = stderr.trim();
  if (errText) {
    return timedOut
      ? `ocr 执行超时被终止（已运行超过 ${minutes} 分钟）— 最后输出: ${errText.slice(-600)}`
      : errText.slice(-2000);
  }
  const outText = stdout.trim();
  if (timedOut) return `ocr 执行超时被终止（超过 ${minutes} 分钟上限，可能是 LLM 响应过慢或仓库过大）`;
  if (outText) return `ocr 退出码 ${code}，无错误输出 — 最后日志: ${outText.slice(-600)}`;
  return `ocr 退出码 ${code} 且无任何输出（进程可能被外部终止或异常崩溃）`;
}
