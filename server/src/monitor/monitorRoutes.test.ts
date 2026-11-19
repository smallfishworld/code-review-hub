import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import Fastify from 'fastify';
import { openDatabase } from '../db/database.js';
import { SecretStore } from '../crypto/secrets.js';
import { CredentialService } from '../crypto/credentialService.js';
import { TaskQueue } from '../tasks/taskQueue.js';
import { MonitorService } from './monitorService.js';
import { buildMonitorRoutes } from './monitorRoutes.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let app: Fastify.FastifyInstance;
let monitor: MonitorService;
let queue: TaskQueue;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crp-monroutes-'));
  db = openDatabase({ dataDir: join(dir, 'db') });
  queue = new TaskQueue(db, async () => ({ exitCode: 0 }), 2);
  const credentials = new CredentialService(db, new SecretStore(join(dir, 'keys')));
  monitor = new MonitorService(db, credentials, queue, { dataDir: join(dir, 'data') });
  app = Fastify();
  buildMonitorRoutes(db, monitor).register(app);
  await app.ready();
});

afterEach(async () => {
  monitor?.stop();
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

function makeSvnRepo(commits: number): { url: string } {
  const repoDir = join(dir, 'svnrepo');
  execSync(`svnadmin create ${JSON.stringify(repoDir)}`);
  const url = 'file:///' + repoDir.replaceAll('\\', '/');
  const wc = join(dir, 'svnwc');
  execSync(`svn checkout ${JSON.stringify(url)} ${JSON.stringify(wc)}`);
  for (let i = 1; i <= commits; i++) {
    mkdirSync(join(wc, 'trunk/src'), { recursive: true });
    writeFileSync(join(wc, `trunk/src/f${i}.cpp`), String(i));
    execSync('svn add --force .', { cwd: wc });
    execSync(`svn commit -m "c${i}" --username u${i}`, { cwd: wc });
  }
  return { url };
}

function addRepo(url: string): number {
  const info = db
    .prepare("INSERT INTO repo (type, name, url) VALUES ('svn', 'r1', ?)")
    .run(url);
  return Number(info.lastInsertRowid);
}

const put = (url: string, body: unknown) =>
  app.inject({ method: 'PUT', url, payload: body as never });
const post = (url: string) => app.inject({ method: 'POST', url });

describe('monitor rule API', () => {
  it('creates a rule with defaults and validates input', async () => {
    const { url } = makeSvnRepo(1);
    const repoId = addRepo(url);

    const created = await put(`/api/monitor/rules/${repoId}`, {
      intervalSeconds: 120,
      authorWhitelist: ['zhangsan'],
      pathPrefixes: ['trunk/src/'],
      backtrackNodes: 2,
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as {
      intervalSeconds: number;
      authorWhitelist: string[];
      pathPrefixes: string[];
      backtrackNodes: number;
      enabled: boolean;
    };
    expect(body.intervalSeconds).toBe(120);
    expect(body.authorWhitelist).toEqual(['zhangsan']);
    expect(body.pathPrefixes).toEqual(['trunk/src/']);
    expect(body.backtrackNodes).toBe(2);
    expect(body.enabled).toBe(false); // created disabled

    // invalid interval
    expect((await put(`/api/monitor/rules/${repoId}`, { intervalSeconds: 5 })).statusCode).toBe(400);
    // unknown repo
    expect((await put('/api/monitor/rules/999', {})).statusCode).toBe(404);
  });

  it('updates an existing rule preserving unspecified fields', async () => {
    const { url } = makeSvnRepo(1);
    const repoId = addRepo(url);
    await put(`/api/monitor/rules/${repoId}`, {
      intervalSeconds: 120,
      authorWhitelist: ['a'],
    });
    const updated = await put(`/api/monitor/rules/${repoId}`, { intervalSeconds: 60 });
    const body = updated.json() as { intervalSeconds: number; authorWhitelist: string[] };
    expect(body.intervalSeconds).toBe(60);
    expect(body.authorWhitelist).toEqual(['a']); // preserved
  });

  it('enable initializes the position and disable stops polling', async () => {
    const { url } = makeSvnRepo(3);
    const repoId = addRepo(url);
    await put(`/api/monitor/rules/${repoId}`, { intervalSeconds: 60 });

    const enabled = await post(`/api/monitor/rules/${repoId}/enable`);
    expect(enabled.statusCode).toBe(200);
    const body = enabled.json() as { enabled: boolean; status: { lastNode: string } };
    expect(body.enabled).toBe(true);
    expect(body.status.lastNode).toBe('3'); // HEAD, no historical review

    const disabled = await post(`/api/monitor/rules/${repoId}/disable`);
    expect((disabled.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it('poll endpoint triggers new nodes and reports status', async () => {
    const { url } = makeSvnRepo(1);
    const repoId = addRepo(url);
    await put(`/api/monitor/rules/${repoId}`, { intervalSeconds: 60 });
    await post(`/api/monitor/rules/${repoId}/enable`);

    const wc = join(dir, 'svnwc');
    writeFileSync(join(wc, 'trunk/src/new.cpp'), 'n');
    execSync('svn add --force .', { cwd: wc });
    execSync('svn commit -m "new" --username zhangsan', { cwd: wc });

    const polled = await post(`/api/monitor/rules/${repoId}/poll`);
    expect(polled.statusCode).toBe(200);
    await queue.idle();

    const status = (await app.inject({ method: 'GET', url: '/api/monitor/status' })).json() as {
      lastNode: string;
      recentLog: { action: string; node: string }[];
    }[];
    expect(status[0].lastNode).toBe('2');
    expect(status[0].recentLog.some((l) => l.action === 'triggered')).toBe(true);
  });

  it('poll endpoint rejects a disabled rule instead of silently doing nothing', async () => {
    const { url } = makeSvnRepo(1);
    const repoId = addRepo(url);
    await put(`/api/monitor/rules/${repoId}`, { intervalSeconds: 60 });
    // created disabled — the console's 立即轮询 button must report this
    const polled = await post(`/api/monitor/rules/${repoId}/poll`);
    expect(polled.statusCode).toBe(409);
    expect((polled.json() as { message: string }).message).toContain('未启用');
  });

  it('poll endpoint rejects a disabled repo', async () => {
    const { url } = makeSvnRepo(1);
    const repoId = addRepo(url);
    await put(`/api/monitor/rules/${repoId}`, { intervalSeconds: 60 });
    await post(`/api/monitor/rules/${repoId}/enable`);
    db.prepare('UPDATE repo SET enabled = 0 WHERE id = ?').run(repoId);

    const polled = await post(`/api/monitor/rules/${repoId}/poll`);
    expect(polled.statusCode).toBe(409);
    expect((polled.json() as { message: string }).message).toContain('仓库已停用');
  });

  it('lists rules with status and 404 for unconfigured repo', async () => {
    const { url } = makeSvnRepo(1);
    const repoId = addRepo(url);
    expect((await app.inject({ method: 'GET', url: `/api/monitor/rules/${repoId}` })).statusCode).toBe(404);
    await put(`/api/monitor/rules/${repoId}`, {});
    const list = (await app.inject({ method: 'GET', url: '/api/monitor/rules' })).json() as {
      repoId: number;
      status: unknown;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0].repoId).toBe(repoId);
    expect(list[0].status).not.toBeNull();
  });
});
