import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogService } from './logService.js';
import { buildLogRoutes } from './logRoutes.js';
import Fastify from 'fastify';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-logs-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows file-handle lag on the daily log file; not worth retry loops here
  }
});

describe('LogService', () => {
  it('buffers lines and honors level filtering', () => {
    const logs = new LogService(100, dir);
    logs.debug('task', 'debug line');
    logs.info('ocr', 'info line');
    logs.warn('monitor', 'warn line');
    logs.error('server', 'error line');

    expect(logs.recent().total).toBe(4);
    expect(logs.recent({ level: 'warn' }).total).toBe(2);
    expect(logs.recent({ src: 'ocr' }).items[0]?.msg).toBe('info line');
    expect(logs.recent({ q: 'ERROR' }).total).toBe(1);
  });

  it('trims the ring buffer to capacity', () => {
    const logs = new LogService(10);
    for (let i = 0; i < 50; i++) logs.info('task', `line ${i}`);
    const res = logs.recent();
    expect(res.total).toBe(10);
    expect(res.items[0]?.msg).toBe('line 40');
    expect(res.items.at(-1)?.msg).toBe('line 49');
  });

  it('writes daily JSON-lines files and lists them for download', () => {
    const logs = new LogService(100, dir);
    logs.error('ocr', 'boom');
    const files = logs.files();
    expect(files.length).toBe(1);
    expect(files[0].name).toMatch(/^runtime-\d{4}-\d{2}-\d{2}\.log$/);
    expect(files[0].size).toBeGreaterThan(0);

    const raw = readFileSync(join(dir, 'logs', files[0].name), 'utf8');
    expect(raw).toContain('"msg":"boom"');
    expect(raw).toContain('"level":"error"');
  });

  it('rejects invalid file names (path traversal guard)', () => {
    const logs = new LogService(10, dir);
    logs.info('task', 'x');
    expect(logs.filePath('../../etc/passwd')).toBeNull();
    expect(logs.filePath('runtime-2099-01-01.log')).toBeNull();
    expect(logs.files()[0]?.name).toBeTruthy();
    expect(logs.filePath(logs.files()[0].name)).not.toBeNull();
  });

  it('setLevel raises the minimum captured level', () => {
    const logs = new LogService(10);
    logs.setLevel('warn');
    logs.info('task', 'ignored');
    logs.error('task', 'kept');
    expect(logs.recent({ level: 'info' }).items.map((l) => l.msg)).toEqual(['kept']);
  });
});

describe('log routes', () => {
  it('serves recent lines, files list, and file download', async () => {
    const logs = new LogService(100, dir);
    logs.warn('ocr', 'watch out');
    const app = Fastify();
    buildLogRoutes(logs).register(app);
    await app.ready();

    const list = await app.inject({ method: 'GET', url: '/api/logs?level=warn' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]?.msg).toBe('watch out');

    const files = await app.inject({ method: 'GET', url: '/api/logs/files' });
    expect(files.statusCode).toBe(200);
    const name = files.json().files[0]?.name as string;
    expect(name).toMatch(/^runtime-/);

    const download = await app.inject({ method: 'GET', url: `/api/logs/files/${name}` });
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain('watch out');

    const bad = await app.inject({ method: 'GET', url: '/api/logs/files/..%2Fsecrets' });
    expect(bad.statusCode).toBe(404);

    const lvl = await app.inject({
      method: 'POST',
      url: '/api/logs/level',
      payload: { level: 'error' },
    });
    expect(lvl.statusCode).toBe(200);
    expect(logs.getLevel()).toBe('error');

    const badLvl = await app.inject({
      method: 'POST',
      url: '/api/logs/level',
      payload: { level: 'verbose' },
    });
    expect(badLvl.statusCode).toBe(400);

    await app.close();
  });

  it('only keeps the newest RETAIN_FILES daily files', () => {
    const logs = new LogService(10, dir);
    // Fabricate extra "old" daily files directly (no log written yet, so
    // exactly these 8 exist); files() must sort newest-first.
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']) {
      writeFileSync(join(dir, 'logs', `runtime-${d}.log`), '{}\n', 'utf8');
    }
    const files = logs.files();
    expect(files.length).toBe(8);
    expect(files[0].name > files[files.length - 1].name).toBe(true);
  });

  it('writes the daily file under <dataDir>/logs', () => {
    const logs = new LogService(10, dir);
    logs.info('server', 'hello');
    expect(existsSync(join(dir, 'logs'))).toBe(true);
    expect(readdirSync(join(dir, 'logs')).some((f) => f.startsWith('runtime-'))).toBe(true);
  });
});
