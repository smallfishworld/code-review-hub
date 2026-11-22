import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { bootstrapEngines, getEngineRow } from './registry.js';
import { resolveEngineForRepo, EngineResolveError } from './resolver.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-resolver-'));
  db = openDatabase({ dataDir: dir });
  db.prepare(
    "INSERT INTO repo (type, name, url) VALUES ('git', 'r1', 'http://example/r1')"
  ).run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bootstrapEngines', () => {
  it('inserts exactly one default ocr engine and is idempotent', () => {
    const first = bootstrapEngines(db);
    expect(first.created).toBe(true);
    const second = bootstrapEngines(db);
    expect(second.created).toBe(false);
    const rows = db.prepare('SELECT * FROM engine').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'ocr', enabled: 1 });
    const def = db
      .prepare("SELECT value FROM setting WHERE key = 'default_engine_id'")
      .get() as { value: string };
    expect(Number(def.value)).toBe(first.engineId);
  });
});

describe('resolveEngineForRepo', () => {
  it('falls back to the global default engine', () => {
    bootstrapEngines(db);
    const resolved = resolveEngineForRepo(db, 1);
    expect(resolved.source).toBe('default');
    expect(resolved.row.kind).toBe('ocr');
  });

  it('repo-level overrides the default', () => {
    const def = bootstrapEngines(db);
    const info = db
      .prepare("INSERT INTO engine (name, kind, enabled) VALUES ('other', 'ocr', 1)")
      .run();
    db.prepare('UPDATE repo SET engine_id = ? WHERE id = 1').run(Number(info.lastInsertRowid));
    const resolved = resolveEngineForRepo(db, 1);
    expect(resolved.source).toBe('repo');
    expect(resolved.row.id).not.toBe(def.engineId);
  });

  it('rule-level overrides repo-level', () => {
    bootstrapEngines(db);
    const repo = db
      .prepare("INSERT INTO engine (name, kind, enabled) VALUES ('repo-eng', 'ocr', 1)")
      .run();
    const rule = db
      .prepare("INSERT INTO engine (name, kind, enabled) VALUES ('rule-eng', 'ocr', 1)")
      .run();
    db.prepare('UPDATE repo SET engine_id = ? WHERE id = 1').run(Number(repo.lastInsertRowid));
    const ruleId = Number(db.prepare(
      'INSERT INTO monitor_rule (repo_id, interval_seconds, engine_id, enabled) VALUES (1, 60, ?, 1)'
    ).run(Number(rule.lastInsertRowid)).lastInsertRowid);
    const resolved = resolveEngineForRepo(db, 1, ruleId);
    expect(resolved.source).toBe('rule');
    expect(resolved.row.name).toBe('rule-eng');
    expect(resolveEngineForRepo(db, 1).row.name).toBe('repo-eng');
  });

  it('fails without fallback when the referenced engine is missing', () => {
    bootstrapEngines(db);
    db.pragma('foreign_keys = OFF'); // 允许写入悬空引用（模拟引擎被外部删除）
    db.prepare('UPDATE repo SET engine_id = 999 WHERE id = 1').run();
    db.pragma('foreign_keys = ON');
    expect(() => resolveEngineForRepo(db, 1)).toThrow(EngineResolveError);
  });

  it('fails when the referenced engine is disabled', () => {
    const boot = bootstrapEngines(db);
    db.prepare('UPDATE engine SET enabled = 0 WHERE id = ?').run(boot.engineId);
    expect(() => resolveEngineForRepo(db, 1)).toThrow(EngineResolveError);
  });

  it('falls back to the first enabled engine when default was deleted', () => {
    const boot = bootstrapEngines(db);
    const info = db
      .prepare("INSERT INTO engine (name, kind, enabled) VALUES ('enabled-eng', 'ocr', 1)")
      .run();
    db.prepare('DELETE FROM engine WHERE id = ?').run(boot.engineId);
    db.prepare("DELETE FROM setting WHERE key = 'default_engine_id'").run();
    const resolved = resolveEngineForRepo(db, 1);
    expect(resolved.row.id).toBe(Number(info.lastInsertRowid));
    expect(getEngineRow(db, Number(info.lastInsertRowid))?.name).toBe('enabled-eng');
  });
});
