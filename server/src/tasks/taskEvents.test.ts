import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { TaskQueue, type TaskCompletedEvent, type TaskRecord } from './taskQueue.js';
import { ReportService, type CompletedReviewReport } from './reportService.js';
import { TaskEventHub } from './taskEvents.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let dataDir: string;
let q: TaskQueue | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-events-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  dataDir = join(dir, 'data');
});

afterEach(() => {
  q?.stop();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRepo(db: Database.Database): number {
  const info = db
    .prepare("INSERT INTO repo (type, name, url) VALUES ('svn', 'r1', 'http://x/y')")
    .run();
  return Number(info.lastInsertRowid);
}

/** Executor whose behavior depends on the node name. */
function executor() {
  return async (task: TaskRecord, onSpawn: (c: { kill: (s?: string) => void }) => void) => {
    if (task.node === 'slow') {
      let killed = false;
      onSpawn({ kill: () => { killed = true; } });
      while (!killed) await new Promise((r) => setTimeout(r, 10));
      return { exitCode: -1, error: 'killed' };
    }
    if (task.node === 'bad') return { exitCode: 1, error: 'ocr boom' };
    if (task.node === 'missing') return { exitCode: 0 };
    return { exitCode: 0, report: writeReport(task.id) };
  };
}

function writeReport(taskId: number): CompletedReviewReport {
  mkdirSync(join(dataDir, 'reports'), { recursive: true });
  const rawPath = join(dataDir, 'reports', `${taskId}.json`);
  writeFileSync(rawPath, '{"findings":[{"message":"adapter-specific"}]}');
  return { rawPath, summary: 'normalized summary', engineName: 'test adapter', issues: [
    { file: 'source.ts', startLine: 4, endLine: 8, description: 'normalized issue', severity: 'high' },
  ] };
}

async function setup() {
  const reports = new ReportService(db);
  const queue = new TaskQueue(db, executor(), 2, undefined, reports);
  q = queue;
  const hub = new TaskEventHub(db, queue, reports, dataDir);
  hub.start();
  return { queue, hub, reports };
}

describe('task terminal-state event hook', () => {
  it('emits completed events for succeeded and failed terminal states', async () => {
    const { queue } = await setup();
    const repoId = seedRepo(db);
    const events: string[] = [];
    queue.on('completed', (e: TaskCompletedEvent) => events.push(`${e.task.node}:${e.task.status}`));

    queue.enqueue(repoId, 'good', 'manual');
    queue.enqueue(repoId, 'bad', 'manual');
    await queue.idle();
    expect(events.sort()).toEqual(['bad:failed', 'good:succeeded']);
  });

  it('emits for cancelled running tasks', async () => {
    const { queue } = await setup();
    const repoId = seedRepo(db);
    const events: string[] = [];
    queue.on('completed', (e: TaskCompletedEvent) => events.push(e.task.status));
    const t = queue.enqueue(repoId, 'slow', 'manual');
    await new Promise((r) => setTimeout(r, 50));
    queue.cancel(t.id);
    await queue.idle();
    expect(events).toEqual(['cancelled']);
  });

  it('hub fans out to terminal listeners and failure is isolated', async () => {
    const { queue, hub } = await setup();
    const repoId = seedRepo(db);
    const seen: string[] = [];
    hub.onTerminal(() => {
      throw new Error('listener boom');
    });
    hub.onTerminal(async (e) => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push(e.task.status);
    });
    queue.enqueue(repoId, 'good', 'manual');
    await queue.idle();
    // give the async fan-out a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual(['succeeded']);
  });

  it('publishes the normalized report before notifying success listeners', async () => {
    const { queue, hub, reports } = await setup();
    const repoId = seedRepo(db);
    const published = vi.fn((event: TaskCompletedEvent) => reports.detail(event.task.id));
    hub.onTerminal(published);
    const t = queue.enqueue(repoId, 'good', 'manual');
    await queue.idle();
    expect(queue.get(t.id).status).toBe('succeeded');
    expect(published.mock.results[0].value).toMatchObject({
      report: { parsedOk: true, issueCount: 1, summary: 'normalized summary', engine: 'test adapter' },
      issues: [{ file: 'source.ts', line: 4, endLine: 8, description: 'normalized issue' }],
    });
  });

  it('notifies failure when a successful executor returns no usable report', async () => {
    const { queue, hub, reports } = await setup();
    const listener = vi.fn();
    hub.onTerminal(listener);
    const task = queue.enqueue(seedRepo(db), 'missing', 'manual');
    await queue.idle();
    expect(listener).toHaveBeenCalledWith({ task: expect.objectContaining({
      id: task.id, status: 'failed', error: expect.stringContaining('未生成报告'),
    }) });
    expect(reports.detail(task.id)).toBeNull();
  });

  it('rolls back report and issue writes if indexing fails before success commits', async () => {
    const { queue, reports } = await setup();
    const index = reports.indexNormalizedReport.bind(reports);
    vi.spyOn(reports, 'indexNormalizedReport').mockImplementation((taskId, report) => {
      index(taskId, report);
      throw new Error('simulated index failure');
    });
    const task = queue.enqueue(seedRepo(db), 'good', 'manual');
    await queue.idle();
    expect(queue.get(task.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('simulated index failure') });
    expect(reports.detail(task.id)).toBeNull();
  });

  it('finalizes a staged report once after restarting, without rerunning the engine', async () => {
    const { queue, hub, reports } = await setup();
    const repoId = seedRepo(db);
    const taskId = Number(db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, 'staged', 'manual', 'running')"
    ).run(repoId).lastInsertRowid);
    db.prepare('UPDATE task SET pending_report = ? WHERE id = ?').run(JSON.stringify(writeReport(taskId)), taskId);
    const listener = vi.fn();
    hub.onTerminal(listener);
    queue.recoverFromRestart();
    queue.recoverFromRestart();
    await queue.idle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(queue.get(taskId).status).toBe('succeeded');
    expect(reports.issues(taskId)).toHaveLength(1);
    expect(db.prepare('SELECT pending_report FROM task WHERE id = ?').get(taskId))
      .toEqual({ pending_report: null });
  });

  it('hub does not index failed/cancelled tasks (no report file)', async () => {
    const { queue } = await setup();
    const repoId = seedRepo(db);
    const t = queue.enqueue(repoId, 'bad', 'manual');
    await queue.idle();
    expect(new ReportService(db).get(t.id)).toBeNull();
  });
});
