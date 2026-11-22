import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { RepoService } from '../repos/repoService.js';
import { ReportService } from '../tasks/reportService.js';
import { TaskQueue, type TaskRecord } from '../tasks/taskQueue.js';
import { TriggerService } from '../tasks/triggerService.js';
import { OcrRunner, workCopyDir } from '../tasks/ocrRunner.js';
import { bootstrapEngines } from './registry.js';
import { EngineExecutor } from './executor.js';
import { OcrEngine, ocrHomeDir } from './ocrEngine.js';
import type { ReviewRequest } from './types.js';

let dir: string;
let db: Database.Database;
let credentials: CredentialService;
let executor: EngineExecutor;
let reports: ReportService;
let queue: TaskQueue;
let repos: RepoService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-execution-'));
  db = openDatabase({ dataDir: dir });
  credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  bootstrapEngines(db);
  executor = new EngineExecutor(db, credentials, { dataDir: dir });
  reports = new ReportService(db);
  queue = new TaskQueue(db, executor.execute, 2, undefined, reports);
  repos = new RepoService(db, credentials, dir);
  vi.spyOn(OcrEngine.prototype, 'probe').mockResolvedValue({ ok: true, degraded: ['memory', 'mcp'] });
});

afterEach(async () => {
  await queue.idle();
  queue.stop();
  vi.restoreAllMocks();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addRepo(): number {
  return Number(db.prepare(
    "INSERT INTO repo (type, name, url, branch) VALUES ('git', 'fixture', 'file:///unused.git', 'main')"
  ).run().lastInsertRowid);
}

function writeReport(req: ReviewRequest, description = 'reviewed'): { exitCode: number } {
  writeFileSync(req.reportPath, JSON.stringify({ status: 'success', comments: [{ content: description }] }));
  return { exitCode: 0 };
}

function createSvnRepo(name: string): string {
  const repo = join(dir, name);
  const files = join(dir, `${name}-files`);
  mkdirSync(files);
  writeFileSync(join(files, 'sample.txt'), name);
  execFileSync('svnadmin', ['create', repo]);
  const url = pathToFileURL(repo).href;
  execFileSync('svn', ['import', files, url, '-m', 'fixture', '--non-interactive']);
  return url;
}

describe('engine execution and report publication', () => {
  it.each([undefined, 'not JSON', '{}', '{"status":"error","comments":[]}'])(
    'fails when an exit-zero engine publishes an unusable report (%s)',
    async (raw) => {
      vi.spyOn(OcrEngine.prototype, 'prepare').mockResolvedValue({ changedFiles: [], identifiers: [] });
      vi.spyOn(OcrEngine.prototype, 'review').mockImplementation(async (req) => {
        if (raw !== undefined) writeFileSync(req.reportPath, raw);
        return { exitCode: 0 };
      });
      const task = queue.enqueue(addRepo(), 'abcd', 'manual');
      await queue.idle();
      expect(queue.get(task.id)).toMatchObject({
        status: 'failed', error: expect.stringContaining('评审报告无效'),
      });
      expect(reports.get(task.id)).toBeNull();
    }
  );

  it('uses the triggering rule only for automatic tasks and keeps its queued engine after a rule edit', async () => {
    const repoId = addRepo();
    const addEngine = (name: string) => Number(db.prepare(
      "INSERT INTO engine (name, kind) VALUES (?, 'ocr')"
    ).run(name).lastInsertRowid);
    const repoEngine = addEngine('repo-engine');
    const ruleEngine = addEngine('rule-engine');
    db.prepare('UPDATE repo SET engine_id = ? WHERE id = ?').run(repoEngine, repoId);
    const ruleId = Number(db.prepare(
      'INSERT INTO monitor_rule (repo_id, interval_seconds, enabled, engine_id) VALUES (?, 60, 1, ?)'
    ).run(repoId, ruleEngine).lastInsertRowid);
    vi.spyOn(OcrEngine.prototype, 'prepare').mockResolvedValue({ changedFiles: [], identifiers: [] });
    vi.spyOn(OcrEngine.prototype, 'review').mockImplementation(async (req) => {
      writeFileSync(req.reportPath, '{"adapter_result":["raw payload"]}');
      return { exitCode: 0 };
    });
    const normalize = vi.spyOn(OcrEngine.prototype, 'normalize').mockReturnValue({
      summary: 'adapter summary',
      issues: [{ file: 'src/app.ts', startLine: 7, description: 'adapter issue' }],
    });
    const manual = queue.enqueue(repoId, 'abcd', 'manual');
    const auto = queue.enqueue(repoId, 'abcd', 'auto', 'author', { monitorRuleId: ruleId });
    db.prepare('UPDATE monitor_rule SET enabled = 0, engine_id = ? WHERE id = ?').run(repoEngine, ruleId);
    await queue.idle();
    expect(queue.get(manual.id)).toMatchObject({ engineId: repoEngine, status: 'succeeded' });
    expect(queue.get(manual.id).monitorRuleId).toBeUndefined();
    expect(queue.get(auto.id)).toMatchObject({ monitorRuleId: ruleId, engineId: ruleEngine, status: 'succeeded' });
    expect(normalize).toHaveBeenCalledTimes(2);
    expect(reports.detail(manual.id)).toMatchObject({ report: { engine: 'repo-engine' } });
    expect(reports.detail(auto.id)).toMatchObject({
      report: { engine: 'rule-engine', summary: 'adapter summary' },
      issues: [{ file: 'src/app.ts', line: 7, description: 'adapter issue' }],
    });
  });

  it('isolates SVN sources after a URL edit, clears the cursor and rejects previously queued revisions', async () => {
    const original = createSvnRepo('original');
    const replacement = createSvnRepo('replacement');
    const repo = await repos.create({ type: 'svn', name: 'fixture', url: original });
    const trigger = new TriggerService(db, credentials, queue, dir);
    const ruleId = Number(db.prepare(
      'INSERT INTO monitor_rule (repo_id, interval_seconds, enabled) VALUES (?, 60, 1)'
    ).run(repo.id).lastInsertRowid);
    db.prepare("INSERT INTO monitor_state (rule_id, last_node, head_node) VALUES (?, '99', '99')").run(ruleId);
    vi.spyOn(OcrEngine.prototype, 'review').mockImplementation(async (req, ctx) => {
      const workspace = workCopyDir(dir, ctx.task.repoId, ctx.task.sourceVersion, ctx.task.workspaceSlot);
      return writeReport(req, readFileSync(join(workspace, 'sample.txt'), 'utf8'));
    });
    const before = (await trigger.triggerSingle(repo.id, '1')).task!;
    await queue.idle();
    expect(reports.issues(before.id)[0].description).toBe('original');
    const queued = Number(db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, '1', 'manual', 'queued')"
    ).run(repo.id).lastInsertRowid);

    await repos.update(repo.id, { type: 'svn', name: 'fixture', url: replacement });
    expect(db.prepare('SELECT last_node FROM monitor_state WHERE rule_id = ?').get(ruleId)).toBeUndefined();
    const after = (await trigger.triggerSingle(repo.id, '1')).task!;
    await queue.idle();
    expect(queue.get(queued)).toMatchObject({ status: 'failed', error: expect.stringContaining('仓库来源已变更') });
    expect(queue.get(after.id)).toMatchObject({ sourceVersion: 1, status: 'succeeded' });
    expect(reports.issues(after.id)[0].description).toBe('replacement');
    expect(readFileSync(join(workCopyDir(dir, repo.id), 'sample.txt'), 'utf8')).toBe('original');
  });

  it('repairs a legacy SVN work copy that already points at the wrong URL', async () => {
    const original = createSvnRepo('old');
    const replacement = createSvnRepo('current');
    const repo = await repos.create({ type: 'svn', name: 'fixture', url: replacement });
    const workspace = workCopyDir(dir, repo.id);
    mkdirSync(join(dir, 'workcopies'), { recursive: true });
    execFileSync('svn', ['checkout', original, workspace]);
    vi.spyOn(OcrEngine.prototype, 'review').mockImplementation(async (req) =>
      writeReport(req, readFileSync(join(workspace, 'sample.txt'), 'utf8'))
    );
    const task = queue.enqueue(repo.id, '1', 'manual');
    await queue.idle();
    expect(queue.get(task.id).status).toBe('succeeded');
    expect(reports.issues(task.id)[0].description).toBe('current');
  });
});

describe('parallel review workspaces', () => {
  it.each(['git', 'svn'] as const)('keeps two %s snapshots and ocr configs isolated', async (type) => {
    const origin = join(dir, 'origin');
    let url: string;
    let first: string;
    let second: string;
    if (type === 'git') {
      const git = (args: string[]) => execFileSync('git', args, { cwd: origin, encoding: 'utf8' });
      execFileSync('git', ['init', '-b', 'main', origin], { stdio: 'ignore' });
      const commit = (content: string) => {
        writeFileSync(join(origin, 'sample.txt'), content);
        git(['add', 'sample.txt']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', content]);
        return git(['rev-parse', 'HEAD']).trim();
      };
      url = origin;
      first = commit('first');
      second = commit('second');
    } else {
      url = createSvnRepo('first');
      execFileSync('svn', ['checkout', url, origin]);
      writeFileSync(join(origin, 'sample.txt'), 'second');
      execFileSync('svn', ['commit', '-m', 'second', origin]);
      first = '1';
      second = '2';
    }

    const sourceVersion = 3;
    const addProvider = (name: string, model: string) => db.prepare(
      "INSERT INTO provider (name, api_base, model, protocol) VALUES (?, 'http://127.0.0.1:11434/v1', ?, 'openai')"
    ).run(name, model).lastInsertRowid;
    addProvider('global', 'global-model');
    const providerId = addProvider('repository', 'repository-model');
    const repoId = Number(db.prepare(
      `INSERT INTO repo (type, name, url, branch, source_version, provider_id)
       VALUES (?, 'parallel-fixture', ?, 'main', ?, ?)`
    ).run(type, url, sourceVersion, providerId).lastInsertRowid);
    const auth = { type, url, branch: 'main' };
    const tasks: TaskRecord[] = [first, second].map((node, workspaceSlot) => ({
      id: workspaceSlot + 1, repoId, sourceVersion, workspaceSlot, node,
      trigger: 'manual', status: 'running', createdAt: '',
    }));
    const contexts = tasks.map((task) => ({ task, auth, onSpawn() {} }));
    const engines = tasks.map(() => new OcrEngine(1, 'ocr', db, credentials, { dataDir: dir }));
    const results = await Promise.all(engines.map((engine, i) => engine.prepare(contexts[i])));
    const expected = (slot: number) => workCopyDir(dir, repoId, sourceVersion, slot);
    expect(results.map((result) => result.workspacePath)).toEqual([expected(0), expected(1)]);
    expect(results.map((result) => result.changedFiles)).toEqual([['sample.txt'], ['sample.txt']]);
    expect(expected(0)).toBe(workCopyDir(dir, repoId, sourceVersion));
    expect(expected(1)).not.toBe(expected(0));

    const run = vi.spyOn(OcrRunner.prototype, 'runOcr').mockResolvedValue({ exitCode: 0 });
    await Promise.all(engines.map((engine, i) => engine.review({
      task: tasks[i],
      reportPath: join(dir, `report-${i}.json`),
      mcpServers: { codegraph: { workspace: expected(i) } },
    }, contexts[i])));
    for (const [i, content] of ['first', 'second'].entries()) {
      const [args, , , env] = run.mock.calls[i];
      const home = ocrHomeDir(dir, repoId, sourceVersion, i);
      expect(args[args.indexOf('--repo') + 1]).toBe(expected(i));
      expect(args[args.indexOf('--commit') + 1]).toBe(tasks[i].node);
      expect(readFileSync(join(expected(i), 'sample.txt'), 'utf8')).toBe(content);
      expect(env).toMatchObject({ HOME: home, USERPROFILE: home });
      const config = JSON.parse(readFileSync(join(home, '.opencodereview', 'config.json'), 'utf8'));
      expect(config).toMatchObject({
        provider: 'repository',
        custom_providers: { repository: { model: 'repository-model' } },
        mcp_servers: { codegraph: { workspace: expected(i) } },
      });
    }
  });
});

describe('review cancellation', () => {
  it('cancels a running Git preparation before it can start the review', async () => {
    const remote = join(dir, 'origin');
    execFileSync('git', ['init', '-b', 'main', remote], { stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-m', 'fixture'], { cwd: remote, stdio: 'ignore' });
    const repo = await repos.create({ type: 'git', name: 'fixture', url: remote });
    const review = vi.spyOn(OcrEngine.prototype, 'review');
    let children = 0;
    queue.stop();
    queue = new TaskQueue(db, (task, onSpawn, signal) => executor.execute(task, (child) => {
      onSpawn(child);
      if (++children === 1) queue.cancel(task.id);
    }, signal), 2, undefined, reports);
    const id = queue.enqueue(repo.id, 'abcd', 'manual').id;
    await queue.idle();
    expect(children).toBe(1);
    expect(queue.get(id).status).toBe('cancelled');
    expect(review).not.toHaveBeenCalled();
    expect(reports.get(id)).toBeNull();
  });

  it.each([true, false])('does not retry generic OCR failures with project memory (cancelled=%s)', async (cancelled) => {
    const controller = new AbortController();
    const run = vi.spyOn(OcrRunner.prototype, 'runOcr').mockImplementation(async () => {
      if (cancelled) controller.abort(new Error('cancelled by user'));
      return { exitCode: 1, error: 'provider timed out' };
    });
    const engine = new OcrEngine(1, 'ocr', db, credentials, { dataDir: dir });
    const task = { id: 91, repoId: 1, node: '1', trigger: 'manual', status: 'running', createdAt: '' } as const;
    const result = engine.review(
      { task, reportPath: join(dir, 'report.json'), requirementText: 'project memory' },
      { task, auth: { type: 'svn', url: 'file:///unused' }, signal: controller.signal, onSpawn() {} }
    );
    if (cancelled) await expect(result).rejects.toThrow('cancelled by user');
    else await expect(result).resolves.toMatchObject({ exitCode: 1, error: 'provider timed out' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
