import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { TaskQueue, type TaskCompletedEvent, type TaskRecord } from './taskQueue.js';
import { ReportService } from './reportService.js';
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
    return { exitCode: 0 };
  };
}

async function setup() {
  const queue = new TaskQueue(db, executor(), 2);
  q = queue;
  const hub = new TaskEventHub(db, queue, new ReportService(db), dataDir);
  hub.start();
  return { queue, hub };
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

  it('hub indexes the report of succeeded tasks', async () => {
    const { queue } = await setup();
    const repoId = seedRepo(db);
    const t = queue.enqueue(repoId, 'good', 'manual');
    // pre-create the report file the runner would have written
    mkdirSync(join(dataDir, 'reports'), { recursive: true });
    const rawPath = join(dataDir, 'reports', `${t.id}.json`);
    writeFileSync(rawPath, '{"status":"success","comments":[],"message":"ok"}');
    await queue.idle();
    const reports = new ReportService(db);
    const stored = reports.get(t.id);
    expect(stored).not.toBeNull();
    expect(stored!.parsedOk).toBe(true);
    expect(stored!.issueCount).toBe(0);
  });

  it('hub does not index failed/cancelled tasks (no report file)', async () => {
    const { queue } = await setup();
    const repoId = seedRepo(db);
    const t = queue.enqueue(repoId, 'bad', 'manual');
    await queue.idle();
    expect(new ReportService(db).get(t.id)).toBeNull();
  });
});
