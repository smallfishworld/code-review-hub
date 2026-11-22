import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { parseOcrReport, ReportService } from './reportService.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-report-'));
  db = openDatabase({ dataDir: join(dir, 'data') });
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedTask(db: Database.Database): number {
  const repo = db
    .prepare("INSERT INTO repo (type, name, url) VALUES ('svn', 'r', 'http://x/y')")
    .run();
  const task = db
    .prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, 'r100', 'manual', 'succeeded')"
    )
    .run(Number(repo.lastInsertRowid));
  return Number(task.lastInsertRowid);
}

/** Real ocr JSON shape (cmd/opencodereview/output.go jsonOutput), SVN sample. */
const REAL_SVN_SAMPLE = `{
  "status": "success",
  "trace_id": "tr-abc123",
  "summary": {
    "files_reviewed": 3,
    "comments": 2,
    "total_tokens": 45210,
    "input_tokens": 40110,
    "output_tokens": 5100,
    "elapsed": "1m30s"
  },
  "tool_calls": { "total": 18, "by_tool": {}, "failure": 0, "failure_by_tool": {}, "failure_details": [] },
  "comments": [
    {
      "path": "trunk/src/main.cpp",
      "content": "此处循环内构造 std::string 可能产生频繁内存分配，建议复用。",
      "suggestion_code": "std::string buf;\\nfor (...) { buf.clear(); }",
      "existing_code": "for (...) { std::string buf; }",
      "start_line": 42,
      "end_line": 42,
      "category": "performance",
      "severity": "medium"
    },
    {
      "path": "trunk/include/util.h",
      "content": "线程安全问题：该静态变量未加锁。",
      "start_line": 10,
      "end_line": 12,
      "category": "bug",
      "severity": "high"
    }
  ],
  "message": "Review finished."
}`;

/** Git sample: same schema, paths are repo-relative, zero comments. */
const REAL_GIT_SAMPLE = `{
  "status": "success",
  "summary": { "files_reviewed": 1, "comments": 0, "total_tokens": 1200, "elapsed": "10s" },
  "comments": [],
  "message": "No comments generated. Looks good to me."
}`;

/** Older/minimal output: status only, no summary/message. */
const MINIMAL_SAMPLE = `{"status": "success", "comments": [{"path": "a.py", "content": "x", "start_line": 1}]}`;

describe('parseOcrReport (real ocr jsonOutput shape)', () => {
  it('parses the SVN sample: comments with path/line/severity/description', () => {
    const r = parseOcrReport(REAL_SVN_SAMPLE);
    expect(r.status).toBe('success');
    expect(r.issueCount).toBe(2);
    expect(r.comments[0]).toMatchObject({
      path: 'trunk/src/main.cpp',
      startLine: 42,
      severity: 'medium',
      category: 'performance',
    });
    expect(r.comments[0].content).toContain('内存分配');
    expect(r.comments[0].suggestion).toContain('buf.clear()');
    expect(r.comments[1].severity).toBe('high');
    expect(r.summary).toContain('评审 3 个文件');
  });

  it('parses the Git sample: zero comments + ocr message as summary', () => {
    const r = parseOcrReport(REAL_GIT_SAMPLE);
    expect(r.issueCount).toBe(0);
    expect(r.summary).toBe('[success] 评审 1 个文件，No comments generated. Looks good to me.');
  });

  it('tolerates minimal legacy output without summary/message', () => {
    const r = parseOcrReport(MINIMAL_SAMPLE);
    expect(r.issueCount).toBe(1);
    expect(r.summary).toContain('1 条评审意见');
  });

  it('rejects non-object JSON', () => {
    expect(() => parseOcrReport('[]')).toThrow();
    expect(() => parseOcrReport('"ok"')).toThrow();
    expect(() => parseOcrReport('not json')).toThrow();
  });

  it('tolerates comments entries with wrong shapes', () => {
    const r = parseOcrReport(
      '{"status":"success","comments":[null, 5, {"content":"only text"}, {"path":"p","start_line":"x"}]}'
    );
    expect(r.issueCount).toBe(2);
    expect(r.comments[0].content).toBe('only text');
    expect(r.comments[1].startLine).toBeUndefined();
  });
});

describe('ReportService persistence', () => {
  it('repairs historical successes with unindexed outputs without replaying completed tasks', () => {
    const recovered = seedTask(db);
    const repo = db.prepare('SELECT repo_id FROM task WHERE id = ?').get(recovered) as { repo_id: number };
    const missing = Number(db.prepare(
      "INSERT INTO task (repo_id, node, trigger, status) VALUES (?, 'r200', 'manual', 'succeeded')"
    ).run(repo.repo_id).lastInsertRowid);
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(join(dir, 'reports', `${recovered}.json`), REAL_SVN_SAMPLE);
    const reports = new ReportService(db);
    reports.recoverLegacyIndexes(dir);
    const first = reports.issues(recovered);
    reports.recoverLegacyIndexes(dir);
    expect(first).toHaveLength(2);
    expect(reports.issues(recovered)).toEqual(first);
    expect(db.prepare('SELECT status, error FROM task WHERE id = ?').get(missing)).toEqual({
      status: 'failed', error: '历史评审报告缺失',
    });
  });

  it('indexes a real-format report: summary + issues in DB, raw file kept', () => {
    const taskId = seedTask(db);
    const rawPath = join(dir, 'reports', `${taskId}.json`);
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(rawPath, REAL_SVN_SAMPLE);

    const svc = new ReportService(db);
    const stored = svc.indexTaskReport(taskId, rawPath);
    expect(stored).not.toBeNull();
    expect(stored!.parsedOk).toBe(true);
    expect(stored!.issueCount).toBe(2);
    expect(stored!.summary).toContain('评审 3 个文件');

    const issues = svc.issues(taskId);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      file: 'trunk/src/main.cpp',
      line: 42,
      severity: 'medium',
      category: 'performance',
    });
    expect(issues[0].description).toContain('内存分配');
    expect(issues[0].suggestion).toContain('buf.clear()');
    expect(issues[1].suggestion).toBeNull();

    const detail = svc.detail(taskId);
    expect(detail!.raw).toBe(REAL_SVN_SAMPLE);
  });

  it('collapses duplicate findings from double agent passes to one issue', () => {
    const taskId = seedTask(db);
    const rawPath = join(dir, 'reports', `${taskId}.json`);
    mkdirSync(join(dir, 'reports'), { recursive: true });
    // 观测到的真实形态：ocr 双 pass 对同一文件各 code_comment 一次，两条完全相同
    const raw = `{
      "status": "success",
      "summary": {"files_reviewed": 1, "comments": 2},
      "comments": [
        {"path": "trunk/src/app.ts", "content": "静默忽略异常", "start_line": 7, "end_line": 12, "category": "bug", "severity": "high"},
        {"path": "trunk/src/app.ts", "content": "静默忽略异常", "start_line": 7, "end_line": 12, "category": "bug", "severity": "high"}
      ]
    }`;
    writeFileSync(rawPath, raw);
    const svc = new ReportService(db);
    const stored = svc.indexTaskReport(taskId, rawPath)!;
    expect(stored.issueCount).toBe(1);
    expect(svc.issues(taskId)).toHaveLength(1);
  });

  it('marks succeeded-but-raw when JSON is invalid, keeps raw text', () => {
    const taskId = seedTask(db);
    const rawPath = join(dir, 'reports', `${taskId}.json`);
    mkdirSync(join(dir, 'reports'), { recursive: true });
    writeFileSync(rawPath, '<html>not json</html>');

    const svc = new ReportService(db);
    const stored = svc.indexTaskReport(taskId, rawPath);
    expect(stored!.parsedOk).toBe(false);
    expect(stored!.issueCount).toBe(0);
    expect(stored!.summary).toContain('报告解析失败');
    // raw preserved and readable via detail()
    expect(svc.detail(taskId)!.raw).toBe('<html>not json</html>');
  });

  it('is a no-op when the report file is missing (failed task)', () => {
    const taskId = seedTask(db);
    const svc = new ReportService(db);
    expect(svc.indexTaskReport(taskId, join(dir, 'nope.json'))).toBeNull();
    expect(svc.get(taskId)).toBeNull();
    expect(svc.detail(taskId)).toBeNull();
  });

  it('re-indexing the same task replaces old issues (idempotent upsert)', () => {
    const taskId = seedTask(db);
    const rawPath = join(dir, 'reports', `${taskId}.json`);
    mkdirSync(join(dir, 'reports'), { recursive: true });
    const svc = new ReportService(db);

    writeFileSync(rawPath, REAL_SVN_SAMPLE);
    svc.indexTaskReport(taskId, rawPath);
    writeFileSync(rawPath, REAL_GIT_SAMPLE);
    svc.indexTaskReport(taskId, rawPath);

    const reports = db.prepare('SELECT * FROM report').all() as unknown[];
    expect(reports).toHaveLength(1);
    const issues = svc.issues(taskId);
    expect(issues).toHaveLength(0);
    expect(svc.get(taskId)!.issueCount).toBe(0);
  });
});
