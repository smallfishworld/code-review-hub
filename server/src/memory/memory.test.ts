import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { MemoryStore, memoryDir } from './store.js';
import { MemoryRetrieval, estimateTokens } from './retrieval.js';
import { issueFingerprint, matchSuppressions } from './suppressFilter.js';
import { processFeedback } from './feedback.js';
import { ReportService } from '../tasks/reportService.js';
import { runArchivalScan, runCompaction, bumpReviewCount } from './evolve.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-mem-'));
  db = openDatabase({ dataDir: dir });
  db.prepare(
    "INSERT INTO repo (type, name, url) VALUES ('git', 'r1', 'http://example/r1')"
  ).run();
  store = new MemoryStore(db, dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedIssue(opts?: {
  taskId?: number;
  file?: string | null;
  category?: string | null;
  description?: string;
}): { taskId: number; issueId: number } {
  const taskId =
    opts?.taskId ??
    ((db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM task').get() as { n: number }).n);
  db.prepare(
    "INSERT INTO task (id, repo_id, node, trigger, status) VALUES (?, 1, '1', 'manual', 'succeeded')"
  ).run(taskId);
  db.prepare(
    `INSERT INTO report (id, task_id, summary, issue_count, raw_path, parsed_ok)
     VALUES (?, ?, 's', 1, '/tmp/x.json', 1)`
  ).run(taskId, taskId);
  const info = db
    .prepare(
      `INSERT INTO report_issue (report_id, file, line, category, description)
       VALUES (?, ?, 10, ?, ?)`
    )
    .run(taskId, opts?.file ?? 'src/utils/helper.ts', opts?.category ?? 'bug', opts?.description ?? '可能的空指针引用');
  return { taskId, issueId: Number(info.lastInsertRowid) };
}

describe('memory store + markdown projection', () => {
  it('creates, updates, deletes with markdown in sync', () => {
    const entry = store.create({
      repoId: 1,
      kind: 'convention',
      scope: 'src/utils',
      title: '使用中文注释',
      body: '该仓库所有注释使用中文。',
      confidence: 0.6,
    });
    const file = join(memoryDir(dir, 1), 'conventions.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('使用中文注释');

    store.update(entry.id, { title: '使用中文注释与文档' });
    expect(readFileSync(file, 'utf8')).toContain('使用中文注释与文档');

    store.delete(entry.id);
    expect(existsSync(file)).toBe(false);
  });

  it('suppress entries require a fingerprint', () => {
    expect(() =>
      store.create({ repoId: 1, kind: 'suppression', title: 'x', body: 'y' })
    ).toThrow();
  });

  it('reloadFromMarkdown picks up edits and new sections', () => {
    const entry = store.create({
      repoId: 1,
      kind: 'pitfall',
      title: 'svn 凭据不要入库',
      body: '旧内容',
    });
    const file = join(memoryDir(dir, 1), 'pitfalls.md');
    const edited = readFileSync(file, 'utf8').replace('旧内容', '新内容');
    writeFileSync(file, edited + '\n## 全新条目\n\n手工添加的内容\n');
    const res = store.reloadFromMarkdown(1);
    expect(res.updated).toBe(1);
    expect(res.created).toBe(1);
    expect(store.get(entry.id)!.body).toBe('新内容');
    expect(store.list(1, { status: 'active' }).some((e) => e.title === '全新条目')).toBe(true);
  });
});

describe('retrieval', () => {
  it('matches by scope prefix and ranks by confidence', () => {
    store.create({ repoId: 1, kind: 'convention', scope: 'src/utils', title: 'utils 约定', body: '内容' });
    store.create({ repoId: 1, kind: 'pitfall', scope: 'web/', title: 'web 坑', body: '内容' });
    const picked = new MemoryRetrieval(store, db).retrieve(1, {
      changedFiles: ['src/utils/helper.ts'],
      identifiers: [],
    });
    expect(picked.map((e) => e.title)).toEqual(['utils 约定']);
  });

  it('FTS matches identifiers with operator-looking file names', () => {
    store.create({ repoId: 1, kind: 'pitfall', scope: null, title: 'foo-bar 解析坑', body: '处理 foo-bar.ts 时注意连字符' });
    const picked = new MemoryRetrieval(store, db).retrieve(1, {
      changedFiles: [],
      identifiers: ['foo-bar.ts', 'foo-bar'],
    });
    expect(picked).toHaveLength(1);
  });

  it('respects the token budget (Chinese text estimates correctly)', () => {
    const long = '这是一段很长的中文记忆内容。'.repeat(100);
    store.create({ repoId: 1, kind: 'convention', scope: null, title: '长记忆', body: long });
    const picked = new MemoryRetrieval(store, db).retrieve(1, {
      changedFiles: [],
      identifiers: [],
    });
    expect(picked).toHaveLength(0); // 预算 1500 token，单条中文长文本超过预算
    expect(estimateTokens(long)).toBeGreaterThan(1000);
  });

  it('hides low-confidence entries', () => {
    store.create({ repoId: 1, kind: 'pitfall', scope: null, title: '低置信', body: '内容', confidence: 0.2 });
    const picked = new MemoryRetrieval(store, db).retrieve(1, { changedFiles: [], identifiers: [] });
    expect(picked).toHaveLength(0);
  });

  it('markUsed updates hits and last_used_at', () => {
    const entry = store.create({ repoId: 1, kind: 'glossary', scope: null, title: '术语', body: '定义' });
    store.markUsed([entry.id]);
    const after = store.get(entry.id)!;
    expect(after.hits).toBe(1);
    expect(after.lastUsedAt).not.toBeNull();
  });
});

describe('suppression fingerprint + deterministic filter', () => {
  it('is stable across line numbers and case, differs across files', () => {
    const a = issueFingerprint({ file: 'src/a.ts', category: 'bug', description: '可能空指针 line 10' });
    const b = issueFingerprint({ file: 'src/a.ts', category: 'Bug', description: '可能空指针 line 99' });
    const c = issueFingerprint({ file: 'src/other.ts', category: 'bug', description: '可能空指针 line 10' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('matches issues against active suppression entries', () => {
    store.create({
      repoId: 1,
      kind: 'suppression',
      scope: 'src',
      title: '空指针误报',
      body: '该模式是误报',
      fingerprint: issueFingerprint({ file: 'src/utils/helper.ts', category: 'bug', description: '可能的空指针引用' }),
      confidence: 0.7,
    });
    const matches = matchSuppressions(db, 1, [
      { file: 'src/utils/helper.ts', category: 'bug', description: '可能的空指针引用' },
      { file: 'web/index.tsx', category: 'style', description: '完全不同的问题' },
    ]);
    expect(matches[0]).not.toBeNull();
    expect(matches[1]).toBeNull();
  });
});

describe('feedback loop', () => {
  it('creates a suppression on first false positive, reinforces on the 3rd', () => {
    const first = seedIssue();
    const out1 = processFeedback(db, store, first.taskId, {
      issueId: first.issueId,
      verdict: 'false_positive',
      note: '误报：判空已存在',
    });
    expect(out1.memoryAction).toBe('created');
    const memoryId = out1.memoryId!;
    expect(store.get(memoryId)!.feedbackCount).toBe(1); // 新建即第 1 次人工确认

    // 同指纹第 2、3 次（不同 issue，相同模式）
    const second = seedIssue({ description: '可能的空指针引用' });
    const out2 = processFeedback(db, store, second.taskId, {
      issueId: second.issueId,
      verdict: 'false_positive',
    });
    expect(out2.memoryAction).toBe('reinforced');
    expect(out2.memoryId).toBe(memoryId);

    const beforeConfidence = store.get(memoryId)!.confidence;
    const third = seedIssue({ description: '可能的空指针引用' });
    processFeedback(db, store, third.taskId, {
      issueId: third.issueId,
      verdict: 'false_positive',
    });
    const after = store.get(memoryId)!;
    expect(after.feedbackCount).toBe(3);
    expect(after.confidence).toBeCloseTo(beforeConfidence + 0.1, 5);
  });

  it('is idempotent per (issue, verdict)', () => {
    const issue = seedIssue();
    const a = processFeedback(db, store, issue.taskId, {
      issueId: issue.issueId,
      verdict: 'fixed',
    });
    const b = processFeedback(db, store, issue.taskId, {
      issueId: issue.issueId,
      verdict: 'fixed',
    });
    expect(b.feedbackId).toBe(a.feedbackId);
    expect(b.memoryAction).toBe('none');
  });

  it('rejects a conflicting decision and keeps a multiline note reloadable', () => {
    const { taskId, issueId } = seedIssue();
    const note = '调用方已校验。\n## 兼容旧客户端';
    const result = processFeedback(db, store, taskId, {
      issueId, verdict: 'false_positive', note,
    });
    expect(() => processFeedback(db, store, taskId, {
      issueId, verdict: 'wont_fix', note: '保留该风险。',
    })).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(store.reloadFromMarkdown(1)).toEqual({ updated: 1, created: 0 });
    expect(store.list(1)).toHaveLength(1);
    expect(store.get(result.memoryId!)?.title).toBe('调用方已校验。 ## 兼容旧客户端');
    expect(new ReportService(db).detail(taskId)?.issues[0]?.feedback)
      .toEqual({ verdict: 'false_positive', note });
  });

  it('records the reason for not fixing an issue in project memory and report detail', () => {
    const { taskId, issueId } = seedIssue({ file: 'src/utils/helper.ts' });
    expect(() => processFeedback(db, store, taskId, {
      issueId, verdict: 'wont_fix', note: '  ',
    })).toThrow('请填写不修复原因');
    expect(store.list(1)).toHaveLength(0);

    const note = '兼容旧客户端，保留现有行为。';
    const input = { issueId, verdict: 'wont_fix', note } as const;
    const result = processFeedback(db, store, taskId, input);
    expect(result.memory).toMatchObject({ kind: 'pitfall', scope: 'src/utils/helper.ts', sourceTaskId: taskId });
    expect(result.memory?.body).toContain(note);
    expect(processFeedback(db, store, taskId, input).feedbackId).toBe(result.feedbackId);
    expect(store.list(1)).toHaveLength(1);
    expect(matchSuppressions(db, 1, [{ file: 'src/utils/helper.ts', category: 'bug', description: '可能的空指针引用' }])).toEqual([null]);
    expect(new ReportService(db).detail(taskId)?.issues[0]?.feedback).toEqual({
      verdict: 'wont_fix', note,
    });
  });

  it('recalls active accepted risks for their exact file and original repository source', () => {
    const { taskId, issueId } = seedIssue({ file: 'src\\compat.ts' });
    const result = processFeedback(db, store, taskId, {
      issueId, verdict: 'wont_fix', note: '兼容旧客户端。',
    });
    const memoryId = result.memoryId!;
    const generic = store.create({
      repoId: 1, kind: 'pitfall', scope: null, title: '已知行为', body: '历史说明', confidence: 0.95,
    });
    const retrieval = new MemoryRetrieval(store, db);
    const changes = { changedFiles: ['./src/compat.ts'], identifiers: [] };
    const picked = retrieval.retrieve(1, changes);
    expect(picked.map(({ id }) => id)).toEqual([memoryId, generic.id]);
    expect(picked[0].acceptedRisk).toEqual({ file: 'src/compat.ts', line: 10, node: '1' });
    expect(retrieval.retrieve(1, { changedFiles: ['src/compat.tsx'], identifiers: [] }))
      .toEqual([generic]);

    store.update(memoryId, { status: 'archived' });
    expect(retrieval.retrieve(1, changes)).toEqual([generic]);
    store.update(memoryId, { status: 'active' });
    db.prepare('UPDATE repo SET source_version = 1 WHERE id = 1').run();
    expect(retrieval.retrieve(1, changes)).toEqual([generic]);
  });

  it('rejects feedback for issues of another task', () => {
    const issue = seedIssue();
    db.prepare(
      "INSERT INTO task (id, repo_id, node, trigger, status) VALUES (99, 1, '9', 'manual', 'succeeded')"
    ).run();
    expect(() =>
      processFeedback(db, store, 99, { issueId: issue.issueId, verdict: 'fixed' })
    ).toThrow();
  });
});

describe('evolution', () => {
  it('archives stale low-confidence entries', () => {
    const entry = store.create({
      repoId: 1,
      kind: 'pitfall',
      scope: null,
      title: '陈旧条目',
      body: '内容',
      confidence: 0.2,
    });
    db.prepare('UPDATE memory_entry SET updated_at = ? WHERE id = ?').run(
      new Date(Date.now() - 100 * 86_400_000).toISOString(),
      entry.id
    );
    expect(runArchivalScan(store, 1)).toBe(1);
    expect(store.get(entry.id)!.status).toBe('archived');
  });

  it('compaction merges duplicates every 20 reviews', () => {
    store.create({ repoId: 1, kind: 'convention', scope: null, title: '重复', body: 'a', confidence: 0.5 });
    store.create({ repoId: 1, kind: 'convention', scope: null, title: '重复', body: 'b', confidence: 0.7 });
    expect(runCompaction(db, store, 1)).toEqual({ triggered: false, merged: 0 });
    for (let i = 0; i < 20; i++) bumpReviewCount(db, 1);
    const res = runCompaction(db, store, 1);
    expect(res.triggered).toBe(true);
    expect(res.merged).toBe(1);
    expect(store.list(1, { kind: 'convention' })).toHaveLength(1);
    expect(store.list(1, { kind: 'convention' })[0].confidence).toBe(0.7);
  });
});
