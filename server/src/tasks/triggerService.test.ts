import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { TaskQueue } from './taskQueue.js';
import { OcrRunner } from './ocrRunner.js';
import { buildTaskRoutes } from './taskRoutes.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let dataDir: string;
let app: Fastify.FastifyInstance;
let queue: TaskQueue;

/** Executor that succeeds instantly (no ocr needed for trigger tests). */
const okExecutor = async () => ({ exitCode: 0 });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crp-trigger-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  dataDir = join(dir, 'data');
  queue = new TaskQueue(db, okExecutor, 2);
  const credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  const runner = new OcrRunner(db, credentials, { dataDir });
  void runner;
  app = Fastify();
  buildTaskRoutes(db, credentials, queue, dataDir).register(app);
  await app.ready();
});

afterEach(async () => {
  queue?.stop();
  await app?.close();
  db?.close();
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

function makeGitOrigin(nCommits = 4): { origin: string; shas: string[] } {
  const origin = join(dir, 'origin.git');
  execFileSync('git', ['init', '-b', 'main', origin]);
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: origin });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: origin });
  const shas: string[] = [];
  for (let i = 1; i <= nCommits; i++) {
    writeFileSync(join(origin, `f${i}.txt`), `content ${i}`);
    execFileSync('git', ['add', '.'], { cwd: origin });
    execFileSync('git', ['commit', '-m', `c${i}`], { cwd: origin });
    shas.push(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: origin, encoding: 'utf8' }).toString().trim());
  }
  return { origin, shas };
}

function addGitRepo(origin: string): number {
  const info = db
    .prepare("INSERT INTO repo (type, name, url, branch) VALUES ('git', 'g1', ?, 'main')")
    .run(origin);
  return Number(info.lastInsertRowid);
}

function addSvnRepo(): number {
  const info = db
    .prepare("INSERT INTO repo (type, name, url) VALUES ('svn', 's1', 'http://127.0.0.1:1/nope')")
    .run();
  return Number(info.lastInsertRowid);
}

/** Local file:// SVN repo with one revision per entry. */
function makeSvnRepo(commits: { author: string; file: string }[]): {
  url: string;
  revisions: number[];
} {
  const repoDir = join(dir, 'svnrepo');
  execFileSync('svnadmin', ['create', repoDir]);
  const url = `file:///${repoDir.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const wc = join(dir, 'svnwc');
  execFileSync('svn', ['checkout', url, wc]);
  const revisions: number[] = [];
  for (const c of commits) {
    writeFileSync(join(wc, c.file), `content ${revisions.length + 1}`);
    execFileSync('svn', ['add', '--force', '.'], { cwd: wc });
    const out = execFileSync('svn', ['commit', '-m', 'msg', '--username', c.author], { cwd: wc, encoding: 'utf8' }).toString();
    revisions.push(Number(/Committed revision (\d+)/.exec(out)![1]));
  }
  return { url, revisions };
}

function addRealSvnRepo(url: string): number {
  const info = db
    .prepare("INSERT INTO repo (type, name, url) VALUES ('svn', 's-real', ?)")
    .run(url);
  return Number(info.lastInsertRowid);
}

const post = (url: string, body?: unknown) =>
  app.inject({ method: 'POST', url, payload: body });

describe('task retry API', () => {
  it('queues the same node with its monitor context and reuses an active retry', async () => {
    const repoId = addSvnRepo();
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO task (repo_id, node, trigger, status, author, monitor_rule_id, error)
       VALUES (?, '42', 'auto', 'failed', 'alice', 7, 'previous failure')`
    ).run(repoId);
    const failedId = Number(lastInsertRowid);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    queue['executor'] = async () => {
      await gate;
      return { exitCode: 0 };
    };
    try {
      const [first, second] = await Promise.all([
        post(`/api/tasks/${failedId}/retry`),
        post(`/api/tasks/${failedId}/retry`),
      ]);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      const { task } = first.json();
      expect(task).toMatchObject({ repoId, node: '42', trigger: 'auto', author: 'alice', monitorRuleId: 7 });
      expect(task.id).not.toBe(failedId);
      expect(second.json().task.id).toBe(task.id);
      expect(queue.get(failedId)).toMatchObject({ status: 'failed', error: 'previous failure' });
      expect((await post(`/api/tasks/${task.id}/retry`)).statusCode).toBe(409);
    } finally {
      release();
      await queue.idle();
    }
  });

  it('rejects missing tasks and failed tasks from an old repository source', async () => {
    const repoId = addSvnRepo();
    const { lastInsertRowid } = db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, '42', 'manual', 'failed')"
    ).run(repoId);
    db.prepare('UPDATE repo SET source_version = 1 WHERE id = ?').run(repoId);
    expect((await post('/api/tasks/999/retry')).statusCode).toBe(404);
    expect((await post(`/api/tasks/${lastInsertRowid}/retry`)).statusCode).toBe(409);
    expect(queue.list({}).total).toBe(1);
  });
});

describe('manual trigger API (git)', () => {
  it('triggers a single commit review with a short sha (unique)', async () => {
    const { origin, shas } = makeGitOrigin(2);
    const repoId = addGitRepo(origin);
    const short = shas[0].slice(0, 8);
    const res = await post(`/api/repos/${repoId}/review`, { node: short });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { task: { node: string; status: string } };
    expect(body.task.node).toBe(shas[0]); // normalized to full sha
    await queue.idle();
    expect(queue.get(body.task.id).status).toBe('succeeded');
  });

  it('rejects a non-existent commit with 404 and no task row', async () => {
    const { origin } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    const res = await post(`/api/repos/${repoId}/review`, { node: '0'.repeat(40) });
    expect(res.statusCode).toBe(404);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('bootstraps a clone on demand for full sha (first-time trigger)', async () => {
    const { origin, shas } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    // no prior task → no cached clone; full sha must still work
    const res = await post(`/api/repos/${repoId}/review`, { node: shas[0] });
    expect(res.statusCode).toBe(201);
  });

  it('rejects malformed input', async () => {
    const { origin } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    expect((await post(`/api/repos/${repoId}/review`, {})).statusCode).toBe(400);
    expect((await post(`/api/repos/${repoId}/review`, { node: 'HEAD$()}' })).statusCode).toBe(400);
    expect((await post(`/api/repos/999/review`, { node: '0'.repeat(40) })).statusCode).toBe(404);
  });

  it('duplicate review is 409 unless force=true', async () => {
    const { origin, shas } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    // A never-resolving executor keeps the task running, so the duplicate
    // request deterministically hits an ACTIVE task.
    const hangQueue = new TaskQueue(db, () => new Promise(() => {}), 2);
    const first = hangQueue.enqueue(repoId, shas[0], 'manual');
    const dup = await post(`/api/repos/${repoId}/review`, { node: shas[0] });
    expect(dup.statusCode).toBe(409);
    expect((dup.json() as { duplicate: boolean }).duplicate).toBe(true);
    // force bypasses the check (queue dedup returns the same task)
    const forced = await post(`/api/repos/${repoId}/review`, { node: shas[0], force: true });
    expect(forced.statusCode).toBe(201);
    expect((forced.json() as { task: { id: number } }).task.id).toBe(first.id);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number }).n;
    expect(n).toBe(1);
    hangQueue.stop();
  });

  it('asks for confirmation before re-reviewing a completed node', async () => {
    const { origin, shas: [node] } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    const review = `/api/repos/${repoId}/review`;
    const first = await post(review, { node });
    expect(first.statusCode).toBe(201);
    await queue.idle();
    const firstId = first.json().task.id;
    expect(queue.get(firstId).status).toBe('succeeded');
    expect((await post(review, { node })).statusCode).toBe(409);
    expect((await post(review, { node, force: 'false' })).statusCode).toBe(409);
    const confirmed = await post(review, { node, force: true });
    expect(confirmed.statusCode).toBe(201);
    expect(confirmed.json().task.id).not.toBe(firstId);
    await queue.idle();
  });

  it('a cancelled task does not block re-triggering the node', async () => {
    const { origin, shas } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    // Gate the SHARED queue's executor (the API drains the same queue) so
    // cancel lands while the task is "running", then release it the way a
    // killed ocr child would.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const original = queue['executor'] as typeof okExecutor;
    queue['executor'] = () => gate.then(() => ({ exitCode: 0 }));
    const first = await post(`/api/repos/${repoId}/review`, { node: shas[0] });
    const taskId = (first.json() as { task: { id: number } }).task.id;
    for (let i = 0; i < 100 && queue.get(taskId).status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/cancel`,
    });
    expect(cancelRes.statusCode).toBe(200);
    release();
    await queue.idle();
    expect(queue.get(taskId).status).toBe('cancelled');
    queue['executor'] = original;

    // re-trigger: must create a FRESH task, not return the cancelled row
    const again = await post(`/api/repos/${repoId}/review`, { node: shas[0] });
    expect(again.statusCode).toBe(201);
    const body = again.json() as { task: { id: number; status: string }; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    expect(body.task.id).not.toBe(taskId);
    expect(body.task.status).toBe('queued');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM task').get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it('a failed task does not block re-triggering the node', async () => {
    const { origin, shas } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    // run once to a terminal failed state via a failing executor
    const failQueue = new TaskQueue(db, async () => ({ exitCode: 1, error: 'boom' }), 2);
    const t = failQueue.enqueue(repoId, shas[0], 'manual');
    await failQueue.idle();
    expect(failQueue.get(t.id).status).toBe('failed');
    failQueue.stop();

    const again = await post(`/api/repos/${repoId}/review`, { node: shas[0] });
    expect(again.statusCode).toBe(201);
    const body = again.json() as { task: { id: number; status: string } };
    expect(body.task.id).not.toBe(t.id);
    expect(body.task.status).toBe('queued');
  });

  it('range triggers one task per commit, oldest first', async () => {
    const { origin, shas } = makeGitOrigin(4);
    const repoId = addGitRepo(origin);
    const res = await post(`/api/repos/${repoId}/review-range`, {
      from: shas[0],
      to: shas[3],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tasks: { node: string }[]; duplicates: number };
    expect(body.tasks).toHaveLength(4);
    expect(body.tasks.map((t) => t.node)).toEqual(shas);
    expect(body.duplicates).toBe(0);
  });

  it('range with from > to (non-ancestor) is rejected', async () => {
    const { origin, shas } = makeGitOrigin(2);
    const repoId = addGitRepo(origin);
    const res = await post(`/api/repos/${repoId}/review-range`, {
      from: shas[1],
      to: shas[0],
    });
    expect(res.statusCode).toBe(400);
  });

  it('range missing params is 400', async () => {
    const { origin } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    expect((await post(`/api/repos/${repoId}/review-range`, { from: 'x' })).statusCode).toBe(400);
  });

  it('unreachable svn repo yields 502 with a reason', async () => {
    const repoId = addSvnRepo();
    const res = await post(`/api/repos/${repoId}/review`, { node: '100' });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { message: string }).message).toContain('SVN');
  });

  it('svn invalid revision is 400', async () => {
    const repoId = addSvnRepo();
    const res = await post(`/api/repos/${repoId}/review`, { node: 'abc' });
    expect(res.statusCode).toBe(400);
  });
});

describe('manual trigger API (svn, local repo)', () => {
  it('triggers a single revision', async () => {
    const { url, revisions } = makeSvnRepo([
      { author: 'alice', file: 'a.txt' },
      { author: 'bob', file: 'b.txt' },
    ]);
    const repoId = addRealSvnRepo(url);
    const res = await post(`/api/repos/${repoId}/review`, { node: String(revisions[1]) });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { task: { node: string; author: string } };
    expect(body.task.node).toBe(String(revisions[1]));
    expect(body.task.author).toBe('bob');
    await queue.idle();
  });

  it('rejects a revision past HEAD with 404', async () => {
    const { url, revisions } = makeSvnRepo([{ author: 'alice', file: 'a.txt' }]);
    const repoId = addRealSvnRepo(url);
    const res = await post(`/api/repos/${repoId}/review`, {
      node: String(revisions[0] + 5),
    });
    expect(res.statusCode).toBe(404);
  });

  it('range creates one task per revision, oldest first', async () => {
    const { url, revisions } = makeSvnRepo([
      { author: 'alice', file: 'a.txt' },
      { author: 'bob', file: 'b.txt' },
      { author: 'carol', file: 'c.txt' },
    ]);
    const repoId = addRealSvnRepo(url);
    const res = await post(`/api/repos/${repoId}/review-range`, {
      from: String(revisions[0]),
      to: String(revisions[2]),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tasks: { node: string; author: string }[] };
    expect(body.tasks.map((t) => t.node)).toEqual(revisions.map(String));
    expect(body.tasks.map((t) => t.author)).toEqual(['alice', 'bob', 'carol']);
    await queue.idle();
  });

  it('range past HEAD is clamped to HEAD', async () => {
    const { url, revisions } = makeSvnRepo([
      { author: 'alice', file: 'a.txt' },
      { author: 'bob', file: 'b.txt' },
    ]);
    const repoId = addRealSvnRepo(url);
    const res = await post(`/api/repos/${repoId}/review-range`, {
      from: String(revisions[0]),
      to: String(revisions[1] + 10),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { tasks: { node: string }[] };
    expect(body.tasks.map((t) => t.node)).toEqual(revisions.map(String));
    await queue.idle();
  });

  it('range entirely past HEAD is 404', async () => {
    const { url, revisions } = makeSvnRepo([{ author: 'alice', file: 'a.txt' }]);
    const repoId = addRealSvnRepo(url);
    const res = await post(`/api/repos/${repoId}/review-range`, {
      from: String(revisions[0] + 5),
      to: String(revisions[0] + 9),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('task query API', () => {
  it('lists with filters and pagination', async () => {
    const { origin, shas } = makeGitOrigin(3);
    const repoId = addGitRepo(origin);
    await post(`/api/repos/${repoId}/review-range`, { from: shas[0], to: shas[2] });
    await queue.idle();

    const all = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect((all.json() as { total: number }).total).toBe(3);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/tasks?repoId=${repoId}&status=succeeded&limit=2`,
    });
    const body = filtered.json() as { total: number; items: unknown[] };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(2);

    const one = await app.inject({
      method: 'GET',
      url: `/api/tasks?node=${shas[0].slice(0, 8)}`,
    });
    expect((one.json() as { total: number }).total).toBe(1);
  });

  it('get by id and 404 for unknown', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/tasks/999' });
    expect(missing.statusCode).toBe(404);
  });

  it('cancel endpoint cancels a running task', async () => {
    // long-running executor so the task is still "running" at cancel time
    const slowQueue = new TaskQueue(
      db,
      async (_task, onSpawn) => {
        let killed = false;
        onSpawn({ kill: () => { killed = true; } });
        const start = Date.now();
        while (Date.now() - start < 60_000) {
          if (killed) return { exitCode: -1, error: 'killed' };
          await new Promise((r) => setTimeout(r, 20));
        }
        return { exitCode: 0 };
      },
      1
    );
    queue = slowQueue;
    const app2 = Fastify();
    const credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
    buildTaskRoutes(db, credentials, slowQueue, dataDir).register(app2);
    await app2.ready();

    const { origin, shas } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    await app2.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/review`,
      payload: { node: shas[0] },
    });
    await new Promise((r) => setTimeout(r, 100));
    // wait until the task is actually running (clone bootstrap takes a while)
    const taskId = Number((db.prepare('SELECT id FROM task').get() as { id: number }).id);
    for (let i = 0; i < 200 && queue.get(taskId).status !== 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(queue.get(taskId).status).toBe('running');
    const cancelRes = await app2.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel` });
    expect(cancelRes.statusCode).toBe(200);
    await slowQueue.idle();
    // after idle, the cancelled task reached its terminal state
    expect(queue.get(taskId).status).toBe('cancelled');
    await app2.close();
  });

  it('cancel endpoint distinguishes a missing task from a finished one', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/tasks/999/cancel' });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { message: string }).message).toContain('不存在');

    // a task that already reached a terminal state is a 409, not a 404
    const { origin, shas } = makeGitOrigin(1);
    const repoId = addGitRepo(origin);
    const created = await app.inject({
      method: 'POST',
      url: `/api/repos/${repoId}/review`,
      payload: { node: shas[0] },
    });
    const taskId = (created.json() as { task: { id: number } }).task.id;
    await queue.idle();
    expect(queue.get(taskId).status).toBe('succeeded');
    const finished = await app.inject({ method: 'POST', url: `/api/tasks/${taskId}/cancel` });
    expect(finished.statusCode).toBe(409);
    expect((finished.json() as { message: string }).message).toContain('已结束');
  });
});
