import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, listTables, SCHEMA_VERSION } from './database.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-db-'));
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openDatabase', () => {
  it('creates all expected tables', () => {
    db = openDatabase({ dataDir: dir });
    const tables = listTables(db);
    for (const expected of [
      'repo',
      'credential',
      'provider',
      'monitor_rule',
      'monitor_state',
      'task',
      'report',
      'report_issue',
      'notification_channel',
      'notification_log',
      'setting',
      'schema_migrations',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('is idempotent across restarts (same data preserved)', () => {
    db = openDatabase({ dataDir: dir });
    db.prepare(
      "INSERT INTO repo (type, name, url) VALUES ('svn', 'repo-a', 'http://svn.example/repo-a')"
    ).run();
    const id = (
      db.prepare('SELECT id FROM repo WHERE name = ?').get('repo-a') as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, 'r1234', 'manual', 'queued')"
    ).run(id);
    db.close();

    // Simulate service restart: reopen the same file.
    db = openDatabase({ dataDir: dir });
    const repo = db.prepare('SELECT * FROM repo WHERE name = ?').get('repo-a') as {
      type: string;
    };
    expect(repo.type).toBe('svn');
    const task = db.prepare('SELECT * FROM task WHERE repo_id = ?').get(id) as {
      node: string;
      status: string;
    };
    expect(task.node).toBe('r1234');
    expect(task.status).toBe('queued');
  });

  it('runs each migration only once', () => {
    db = openDatabase({ dataDir: dir });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(rows.n).toBe(SCHEMA_VERSION); // all migrations applied
    db.close();
    db = openDatabase({ dataDir: dir });
    const rows2 = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
    expect(rows2.n).toBe(SCHEMA_VERSION); // not re-applied
  });

  it('enforces repo type check constraint', () => {
    db = openDatabase({ dataDir: dir });
    expect(() =>
      db.prepare("INSERT INTO repo (type, name, url) VALUES ('hg', 'x', 'u')").run()
    ).toThrow();
  });

  it('enforces task unique (repo, node, trigger)', () => {
    db = openDatabase({ dataDir: dir });
    const info = db
      .prepare("INSERT INTO repo (type, name, url) VALUES ('svn', 'r1', 'u')")
      .run();
    const repoId = Number(info.lastInsertRowid);
    db.prepare(
      "INSERT INTO task (repo_id, node, trigger) VALUES (?, 'r1', 'auto')"
    ).run(repoId);
    expect(() =>
      db.prepare("INSERT INTO task (repo_id, node, trigger) VALUES (?, 'r1', 'auto')").run(repoId)
    ).toThrow();
  });

  it('seeds notification trigger setting and records schema version', () => {
    db = openDatabase({ dataDir: dir });
    const setting = db
      .prepare("SELECT value FROM setting WHERE key = 'notification_trigger'")
      .get() as { value: string };
    expect(setting.value).toBe('all');
    const version = db.pragma('user_version', { simple: true });
    expect(version).toBe(SCHEMA_VERSION);
  });

  it('creates the db file in the data dir', () => {
    db = openDatabase({ dataDir: dir });
    expect(existsSync(join(dir, 'platform.db'))).toBe(true);
  });
});
