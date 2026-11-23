import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { TaskQueue, type TaskRecord, type TaskSpawnHandler } from './taskQueue.js';
import { setRepoProviderPool } from '../providers/pool.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-queue-'));
  db = openDatabase({ dataDir: join(dir, 'data') });
});

afterEach(() => {
  q?.stop();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

let q: TaskQueue | undefined;

/** Fake executor: configurable delay, optional crash simulation. */
function fakeExecutor(
  delayMs = 30,
  opts: { failNode?: string; onSpawnSeen?: (t: TaskRecord) => void } = {}
) {
  return async (task: TaskRecord, onSpawn: (c: { kill: (s?: string) => void }) => void) => {
    opts.onSpawnSeen?.(task);
    // simulate a spawned child so cancellation can kill it
    const child = {
      killed: false,
      kill: () => {
        child.killed = true;
      },
    };
    onSpawn(child);
    const start = Date.now();
    while (Date.now() - start < delayMs) {
      if (child.killed) return { exitCode: -1, error: 'killed' };
      await new Promise((r) => setTimeout(r, 5));
    }
    if (task.node === opts.failNode) return { exitCode: 1, error: 'ocr failed: boom' };
    return { exitCode: 0 };
  };
}

function seedRepo(db: Database.Database, name = 'r1'): number {
  const info = db
    .prepare("INSERT INTO repo (type, name, url) VALUES ('svn', ?, 'http://x/y')")
    .run(name);
  return Number(info.lastInsertRowid);
}

function gatedExecutor() {
  const started: TaskRecord[] = [];
  const active = new Map<number, { release: () => void; signal: AbortSignal }>();
  const executor = async (task: TaskRecord, _onSpawn: TaskSpawnHandler, signal: AbortSignal) => {
    started.push(task);
    await new Promise<void>((release) => active.set(task.id, { release, signal }));
    active.delete(task.id);
    return { exitCode: 0 };
  };
  return {
    started,
    active,
    executor,
    release(task: TaskRecord) {
      active.get(task.id)!.release();
    },
  };
}

describe('TaskQueue lifecycle', () => {
  it('queues -> runs -> succeeds and emits completion events', async () => {
    q = new TaskQueue(db, fakeExecutor());
    const events: string[] = [];
    q.on('completed', (e) => events.push(`${e.task.status}:${e.task.node}`));
    const repoId = seedRepo(db);
    const t = q.enqueue(repoId, 'r100', 'manual', 'zhangsan');
    expect(t.status).toBe('queued');
    await q.idle();
    const after = q.get(t.id);
    expect(after.status).toBe('succeeded');
    expect(events).toEqual(['succeeded:r100']);
  });

  it('marks failed tasks with ocr error output', async () => {
    q = new TaskQueue(db, fakeExecutor(10, { failNode: 'r500' }));
    const repoId = seedRepo(db);
    const t = q.enqueue(repoId, 'r500', 'manual');
    await q.idle();
    const after = q.get(t.id);
    expect(after.status).toBe('failed');
    expect(after.error).toContain('ocr failed: boom');
    expect(after.ocrExitCode).toBe(1);
  });

  it('runs tasks of the same repo serially and different repos in parallel', async () => {
    const active = { r1: 0, r2: 0, maxR1: 0, maxR2: 0 };
    const executor = async (task: TaskRecord) => {
      const key = task.repoId === 1 ? 'r1' : 'r2';
      active[key]++;
      active[`max${key === 'r1' ? 'R1' : 'R2'}`] = Math.max(active[`max${key === 'r1' ? 'R1' : 'R2'}`], active[key]);
      await new Promise((r) => setTimeout(r, 60));
      active[key]--;
      return { exitCode: 0 };
    };
    q = new TaskQueue(db, executor, 2);
    seedRepo(db, 'r1'); // id 1
    seedRepo(db, 'r2'); // id 2
    db.prepare('UPDATE repo SET review_concurrency = 1').run();
    q.enqueue(1, 'a1', 'manual');
    q.enqueue(1, 'a2', 'manual');
    q.enqueue(2, 'b1', 'manual');
    q.enqueue(2, 'b2', 'manual');
    await q.idle();
    expect(active.maxR1).toBe(1); // serial per repo
    expect(active.maxR2).toBe(1);
    // all four finished
    const { total } = q.list({});
    expect(total).toBe(4);
    const succeeded = q.list({ status: 'succeeded' });
    expect(succeeded.total).toBe(4);
  });

  it('leases two slots by default, skips saturated repositories, and honors the global limit', async () => {
    const gate = gatedExecutor();
    const queue = q = new TaskQueue(db, gate.executor, 3);
    const a = seedRepo(db, 'a');
    const b = seedRepo(db, 'b');
    const a1 = queue.enqueue(a, 'a1', 'manual');
    const a2 = queue.enqueue(a, 'a2', 'manual');
    const a3 = queue.enqueue(a, 'a3', 'manual');
    const b1 = queue.enqueue(b, 'b1', 'manual');
    const b2 = queue.enqueue(b, 'b2', 'manual');

    await vi.waitFor(() => expect(gate.started.map(({ id }) => id)).toEqual([a1.id, a2.id, b1.id]));
    expect(gate.started.map(({ workspaceSlot }) => workspaceSlot)).toEqual([0, 1, 0]);
    expect(queue.get(a1.id).workspaceSlot).toBeUndefined();
    expect(queue.get(a3.id).status).toBe('queued');
    expect(queue.get(b2.id).status).toBe('queued');

    gate.release(a2);
    await vi.waitFor(() => expect(gate.started.at(-1)).toMatchObject({ id: a3.id, workspaceSlot: 1 }));
    expect(queue.get(b2.id).status).toBe('queued');

    gate.release(b1);
    await vi.waitFor(() => expect(gate.started.at(-1)).toMatchObject({ id: b2.id, workspaceSlot: 0 }));
    for (const task of [a1, a3, b2]) gate.release(task);
    await queue.idle();
  });

  it('keeps a cancelled slot leased until its executor exits and honors live repository limits', async () => {
    const gate = gatedExecutor();
    const queue = q = new TaskQueue(db, gate.executor, 4);
    const repoId = seedRepo(db);
    const first = queue.enqueue(repoId, 'r1', 'manual');
    const second = queue.enqueue(repoId, 'r2', 'manual');
    const third = queue.enqueue(repoId, 'r3', 'manual');
    await vi.waitFor(() => expect(gate.started).toHaveLength(2));

    expect(queue.cancel(first.id)).toBe(true);
    expect(gate.active.get(first.id)?.signal.aborted).toBe(true);
    expect(gate.active.get(second.id)?.signal.aborted).toBe(false);
    db.prepare('UPDATE repo SET review_concurrency = 1 WHERE id = ?').run(repoId);
    const other = queue.enqueue(seedRepo(db, 'other'), 'r4', 'manual');
    await vi.waitFor(() => expect(gate.started.at(-1)?.id).toBe(other.id));
    expect(queue.get(third.id).status).toBe('queued');
    expect(queue.get(first.id).status).toBe('running');

    gate.release(first);
    await vi.waitFor(() => expect(queue.get(first.id).status).toBe('cancelled'));
    expect(queue.get(third.id).status).toBe('queued');
    db.prepare('UPDATE repo SET review_concurrency = 2 WHERE id = ?').run(repoId);
    queue.kick();
    await vi.waitFor(() => expect(gate.started.at(-1)).toMatchObject({ id: third.id, workspaceSlot: 0 }));
    for (const task of [second, third, other]) gate.release(task);
    await queue.idle();
  });

  it('runs a queued task for a deleted repository so it can fail explicitly', async () => {
    const repoId = seedRepo(db);
    const taskId = Number(db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, 'r1', 'auto', 'queued')"
    ).run(repoId).lastInsertRowid);
    db.prepare('DELETE FROM repo WHERE id = ?').run(repoId);
    const execute = vi.fn(async () => { throw new Error('repo not found'); });
    const queue = q = new TaskQueue(db, execute);
    queue.kick();
    await queue.idle();
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.get(taskId)).toMatchObject({ status: 'failed', error: 'repo not found' });
  });

  it('cancelByRepo cancels queued and running tasks of that repo only', async () => {
    const gate = gatedExecutor();
    const queue = q = new TaskQueue(db, gate.executor, 4);
    const repoA = seedRepo(db, 'a');
    const repoB = seedRepo(db, 'b');
    const a1 = queue.enqueue(repoA, 'r1', 'manual');
    const a2 = queue.enqueue(repoA, 'r2', 'auto');
    const b1 = queue.enqueue(repoB, 'r3', 'manual');
    // repo A allows 2 concurrent reviews, so a1+a2 run; b1 runs too.
    await vi.waitFor(() => expect(gate.started).toHaveLength(3));

    const n = queue.cancelByRepo(repoA);
    expect(n).toBe(2);
    // both were running: they stay "running" until their executors exit
    expect(gate.active.get(a1.id)?.signal.aborted).toBe(true);
    expect(gate.active.get(a2.id)?.signal.aborted).toBe(true);
    expect(gate.active.get(b1.id)?.signal.aborted).toBe(false);

    gate.release(a1);
    gate.release(a2);
    await vi.waitFor(() => expect(queue.get(a1.id).status).toBe('cancelled'));
    expect(queue.get(a2.id).status).toBe('cancelled');
    gate.release(b1);
    await queue.idle();
    expect(queue.get(b1.id).status).toBe('succeeded');
  });

  it('binds a model from the repo pool at enqueue and spreads concurrent tasks', () => {
    const repoId = seedRepo(db);
    const a = Number(db.prepare(
      "INSERT INTO provider (name, api_base, model) VALUES ('a', 'http://x/v1', 'm-a')"
    ).run().lastInsertRowid);
    const b = Number(db.prepare(
      "INSERT INTO provider (name, api_base, model) VALUES ('b', 'http://x/v1', 'm-b')"
    ).run().lastInsertRowid);
    setRepoProviderPool(db, repoId, [a, b]);
    q = new TaskQueue(db, gatedExecutor().executor, 4);
    const t1 = q.enqueue(repoId, 'r1', 'manual');
    const t2 = q.enqueue(repoId, 'r2', 'manual');
    const t3 = q.enqueue(repoId, 'r3', 'manual');
    // 3 tasks, 2 models: a gets 2, b gets 1 — and each binding is persisted.
    expect([t1.providerId, t2.providerId, t3.providerId]).toEqual([a, b, a]);
    expect(t1.providerLabel).toBe('a · m-a');
    const rows = db.prepare('SELECT provider_id, provider_label FROM task ORDER BY id').all() as {
      provider_id: number; provider_label: string;
    }[];
    expect(rows).toEqual([
      { provider_id: a, provider_label: 'a · m-a' },
      { provider_id: b, provider_label: 'b · m-b' },
      { provider_id: a, provider_label: 'a · m-a' },
    ]);
  });

  it('leaves provider unbound when the repo has no pool (inherit global default)', () => {
    const repoId = seedRepo(db);
    q = new TaskQueue(db, gatedExecutor().executor, 4);
    const t = q.enqueue(repoId, 'r1', 'manual');
    expect(t.providerId).toBeUndefined();
    expect(t.providerLabel).toBeUndefined();
  });

  it('cancel kills a running task and marks it cancelled', async () => {
    q = new TaskQueue(db, fakeExecutor(2000)); // long-running
    const repoId = seedRepo(db);
    const t = q.enqueue(repoId, 'r700', 'manual');
    await new Promise((r) => setTimeout(r, 40)); // let it start
    expect(q.get(t.id).status).toBe('running');
    expect(q.cancel(t.id)).toBe(true);
    await q.idle();
    const after = q.get(t.id);
    expect(after.status).toBe('cancelled');
    expect(after.error).toContain('cancelled by user');
  });

  it('cancel a queued task without running it', async () => {
    q = new TaskQueue(db, fakeExecutor(50), 1);
    const repoId = seedRepo(db);
    const t1 = q.enqueue(repoId, 'r1', 'manual');
    const t2 = q.enqueue(repoId, 'r2', 'manual');
    // t1 occupies the only slot; t2 still queued
    q.cancel(t2.id);
    await q.idle();
    expect(q.get(t2.id).status).toBe('cancelled');
    expect(q.get(t1.id).status).toBe('succeeded');
  });

  it('recoverFromRestart marks stale running as failed and requeues queued', async () => {
    // create tasks directly in db as if a previous process left them
    const repoId = seedRepo(db);
    db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, 'r900', 'auto', 'running')"
    ).run(repoId);
    db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, 'r901', 'auto', 'queued')"
    ).run(repoId);
    q = new TaskQueue(db, fakeExecutor(10));
    q.recoverFromRestart();
    await q.idle();
    const stale = db
      .prepare("SELECT * FROM task WHERE node = 'r900'")
      .get() as TaskRecord;
    expect(stale.status).toBe('failed');
    expect(stale.error).toBe('service restarted');
    const requeued = db
      .prepare("SELECT * FROM task WHERE node = 'r901'")
      .get() as TaskRecord;
    expect(requeued.status).toBe('succeeded'); // requeued then executed
  });

  it('enqueueIfNew skips nodes already reviewed (any trigger, not cancelled)', async () => {
    q = new TaskQueue(db, fakeExecutor(5));
    const repoId = seedRepo(db);
    const t1 = q.enqueueIfNew(repoId, 'r1000', 'auto', 'zhangsan');
    expect(t1).not.toBeNull();
    await q.idle();
    const dup = q.enqueueIfNew(repoId, 'r1000', 'manual');
    expect(dup).toBeNull();
    // a cancelled task doesn't block a new one
    const t2 = q.enqueueIfNew(repoId, 'r1001', 'manual');
    q.cancel(t2!.id);
    await q.idle();
    const t3 = q.enqueueIfNew(repoId, 'r1001', 'auto');
    expect(t3).not.toBeNull();
  });

  it('list filters by author/status/trigger/repo and paginates', async () => {
    q = new TaskQueue(db, fakeExecutor(5), 1);
    const a = seedRepo(db, 'a');
    const b = seedRepo(db, 'b');
    q.enqueue(a, 'r1', 'auto', 'zhangsan');
    q.enqueue(a, 'r2', 'manual', 'lisi');
    q.enqueue(b, 'r3', 'auto', 'zhangsan');
    await q.idle();
    expect(q.list({ author: 'zhangsan' }).total).toBe(2);
    expect(q.list({ trigger: 'manual' }).total).toBe(1);
    expect(q.list({ repoId: b }).total).toBe(1);
    expect(q.list({ status: 'succeeded' }).total).toBe(3);
    const page = q.list({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it('list filters by repo type (svn/git)', async () => {
    q = new TaskQueue(db, fakeExecutor(5), 1);
    const svnRepo = seedRepo(db, 'svn-a');
    const gitRepo = Number(
      db
        .prepare("INSERT INTO repo (type, name, url, branch) VALUES ('git', 'git-a', 'http://x/g', 'main')")
        .run().lastInsertRowid
    );
    q.enqueue(svnRepo, 'r1', 'manual');
    q.enqueue(gitRepo, 'abc123', 'manual');
    await q.idle();
    expect(q.list({ repoType: 'svn' }).total).toBe(1);
    expect(q.list({ repoType: 'git' }).total).toBe(1);
    expect(q.list({ repoType: 'git' }).items[0].node).toBe('abc123');
    // deleting the repo keeps history but the soft reference no longer matches
    db.prepare('DELETE FROM repo WHERE id = ?').run(gitRepo);
    expect(q.list({ repoType: 'git' }).total).toBe(0);
    expect(q.list({}).total).toBe(2);
  });

  it('dedupes identical (repo, node, trigger) enqueue', async () => {    q = new TaskQueue(db, fakeExecutor(5));
    const repoId = seedRepo(db);
    const t1 = q.enqueue(repoId, 'r42', 'auto');
    const t2 = q.enqueue(repoId, 'r42', 'auto');
    expect(t1.id).toBe(t2.id);
  });
});
