import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { repoProviderPool, setRepoProviderPool, pickProviderForTask } from './pool.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-pool-'));
  db = openDatabase({ dataDir: join(dir, 'data') });
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function provider(name: string): number {
  return Number(
    db.prepare("INSERT INTO provider (name, api_base, model) VALUES (?, 'http://x/v1', ?)")
      .run(name, `model-${name}`).lastInsertRowid
  );
}

function repo(): number {
  return Number(
    db.prepare("INSERT INTO repo (type, name, url) VALUES ('svn', ?, 'http://x/y')").run(`r${Math.random()}`)
      .lastInsertRowid
  );
}

function task(repoId: number, node: string, providerId: number | null, status = 'queued'): void {
  db.prepare(
    "INSERT INTO task (repo_id, node, trigger, status, provider_id) VALUES (?, ?, 'manual', ?, ?)"
  ).run(repoId, node, status, providerId);
}

describe('provider pool', () => {
  it('stores the pool in operator order and replaces it wholesale', () => {
    const repoId = repo();
    const a = provider('a');
    const b = provider('b');
    setRepoProviderPool(db, repoId, [b, a]);
    expect(repoProviderPool(db, repoId).map((p) => p.providerId)).toEqual([b, a]);
    expect(repoProviderPool(db, repoId)[0].label).toBe('b · model-b');
    // Replacing wholesale keeps the new order.
    setRepoProviderPool(db, repoId, [a]);
    expect(repoProviderPool(db, repoId).map((p) => p.providerId)).toEqual([a]);
  });

  it('drops pool members when their provider row is deleted', () => {
    const repoId = repo();
    const a = provider('a');
    const b = provider('b');
    setRepoProviderPool(db, repoId, [a, b]);
    db.prepare('DELETE FROM provider WHERE id = ?').run(a);
    expect(repoProviderPool(db, repoId).map((p) => p.providerId)).toEqual([b]);
  });

  it('assigns the least-loaded pool member, ties broken by pool order', () => {
    const repoId = repo();
    const a = provider('a');
    const b = provider('b');
    setRepoProviderPool(db, repoId, [a, b]);
    // Empty repo: primary wins.
    expect(pickProviderForTask(db, repoId)?.providerId).toBe(a);
    // Primary already has 2 active tasks -> secondary.
    task(repoId, 'r1', a);
    task(repoId, 'r2', a);
    expect(pickProviderForTask(db, repoId)?.providerId).toBe(b);
    // Terminal tasks do not count as load.
    db.prepare("UPDATE task SET status = 'succeeded' WHERE node = 'r1'").run();
    db.prepare("UPDATE task SET status = 'succeeded' WHERE node = 'r2'").run();
    expect(pickProviderForTask(db, repoId)?.providerId).toBe(a);
    // 3 concurrent reviews across 2 models = 2 + 1 split.
    task(repoId, 'r3', a);
    task(repoId, 'r4', a);
    task(repoId, 'r5', b);
    expect(pickProviderForTask(db, repoId)?.providerId).toBe(b);
  });

  it('returns null for a repo without a pool (inherit global default)', () => {
    const repoId = repo();
    expect(pickProviderForTask(db, repoId)).toBeNull();
  });
});