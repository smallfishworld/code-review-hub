import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { createBridgeTools, runTool, TOOL_DEFS } from './mcpBridge.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-bridge-'));
  db = openDatabase({ dataDir: dir });
  db.prepare("INSERT INTO repo (id, type, name, url) VALUES (1, 'git', 'r1', 'http://example/r1')").run();
  db.prepare("INSERT INTO repo (id, type, name, url) VALUES (2, 'git', 'r2', 'http://example/r2')").run();
  db.prepare(
    `INSERT INTO memory_entry (repo_id, kind, scope, title, body, confidence, status) VALUES
     (1, 'convention', 'trunk/src', '错误必须走 logger', '本项目禁止静默吞掉异常，捕获后必须用 logger.error 记录', 0.7, 'active')`
  ).run();
  db.prepare(
    `INSERT INTO memory_entry (repo_id, kind, scope, title, body, fingerprint, confidence, status) VALUES
     (1, 'suppression', 'trunk/src', '上层有兜底', 'stop() 捕获异常后静默忽略，shutdown 失败将不可观测', 'ee115d00', 0.7, 'active')`
  ).run();
  db.prepare(
    `INSERT INTO memory_entry (repo_id, kind, scope, title, body, confidence, status) VALUES
     (2, 'glossary', NULL, 'r2 专属记忆', '仓库 2 的术语，仓库 1 不可见', 0.6, 'active')`
  ).run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('memory bridge tools', () => {
  it('declares exactly the three read-only tools', () => {
    expect(TOOL_DEFS.map((t) => t.name)).toEqual(['memory_search', 'memory_get', 'memory_stats']);
  });

  it('memory_search hits CJK trigram terms and falls back to LIKE for short terms', async () => {
    const tools = createBridgeTools(db, 1);
    const long = JSON.parse(await tools.memory_search({ query: '静默吞掉异常' })) as {
      entries: { title: string }[];
    };
    expect(long.entries.map((e) => e.title)).toContain('错误必须走 logger');

    // 2-char terms cannot produce trigrams — the LIKE fallback must still hit.
    const short = JSON.parse(await tools.memory_search({ query: '静默' })) as {
      entries: { title: string }[];
    };
    expect(short.entries.length).toBeGreaterThan(0);
  });

  it('memory_search kind filter and limit clamp', async () => {
    const tools = createBridgeTools(db, 1);
    const only = JSON.parse(await tools.memory_search({ query: '静默', kind: 'suppression' })) as {
      entries: { kind: string }[];
    };
    expect(only.entries).toHaveLength(1);
    expect(only.entries[0].kind).toBe('suppression');

    const text = await tools.memory_search({ query: '静默', limit: 99 });
    expect(text).toContain('count');
  });

  it('memory_get returns full entry in repo 1 and hides other repos entries', async () => {
    const r1 = createBridgeTools(db, 1);
    const got = JSON.parse(await r1.memory_get({ id: 2 })) as { title: string; body: string };
    expect(got.title).toBe('上层有兜底');

    const r2 = createBridgeTools(db, 2);
    expect(await r2.memory_get({ id: 2 })).toContain('未找到');
    const r2stats = JSON.parse(await r2.memory_stats({})) as { active: number };
    expect(r2stats.active).toBe(1); // 只有 r2 自己的条目
  });

  it('memory_stats reports counts, fts availability and review count', async () => {
    const tools = createBridgeTools(db, 1);
    db.prepare(
      "INSERT INTO setting (key, value) VALUES ('memory_review_count_1', '4')"
    ).run();
    const stats = JSON.parse(await tools.memory_stats({})) as {
      active: number;
      byKind: Record<string, number>;
      ftsAvailable: boolean;
      reviewCount: number;
    };
    expect(stats.active).toBe(2);
    expect(stats.byKind.convention).toBe(1);
    expect(stats.byKind.suppression).toBe(1);
    expect(stats.ftsAvailable).toBe(true);
    expect(stats.reviewCount).toBe(4);
  });

  it('truncates oversized bodies and rejects empty query / bad ids', async () => {
    db.prepare(
      `INSERT INTO memory_entry (repo_id, kind, title, body, confidence, status) VALUES
       (1, 'pitfall', '长文', '${'x'.repeat(3000)}', 0.5, 'active')`
    ).run();
    const tools = createBridgeTools(db, 1);
    const got = JSON.parse(await tools.memory_get({ id: 4 })) as { body: string };
    expect(got.body.length).toBeLessThanOrEqual(2001); // 截断 + 省略号
    expect(got.body.endsWith('…')).toBe(true);

    expect(await tools.memory_search({ query: '' })).toContain('query');
    expect(await tools.memory_get({ id: -1 })).toContain('正整数');
  });

  it('runTool dispatches and reports unknown tools without throwing', async () => {
    expect(await runTool(db, 1, 'memory_stats', {})).toContain('active');
    expect(await runTool(db, 1, 'nope', {})).toContain('未知工具');
  });

  it('likeSearch OR semantics recall entries matching any term', async () => {
    const tools = createBridgeTools(db, 1);
    // 「logger」只命中 convention；「shutdown」只命中 suppression —— OR 后两条都应返回
    const both = JSON.parse(await tools.memory_search({ query: 'logger shutdown' })) as {
      entries: { title: string }[];
    };
    expect(both.entries.map((e) => e.title).sort()).toEqual(['上层有兜底', '错误必须走 logger']);
  });
});
