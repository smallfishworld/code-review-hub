import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { ReportService } from '../tasks/reportService.js';
import { ShareService, ShareError } from './shareService.js';

let db: Database.Database;
let dir: string;
let reports: ReportService;
let svc: ShareService;
let taskId: number;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-share-test-'));
  db = openDatabase({ dataDir: dir });
  reports = new ReportService(db);
  svc = new ShareService(db, reports);
  // A finished task with an indexed report.
  const info = db
    .prepare(
      `INSERT INTO task (repo_id, node, trigger, status, author, commit_message, commit_date, finished_at)
       VALUES (1, '42', 'manual', 'succeeded', 'zhangsan5', '修复超时', '2026-11-27T08:00:00.000Z',
               strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run();
  taskId = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO report (task_id, summary, issue_count, raw_path, parsed_ok)
     VALUES (?, '测试摘要', 2, 'nonexistent.json', 1)`
  ).run(taskId);
  db.prepare(
    `INSERT INTO report_issue (report_id, file, line, severity, category, description, suggestion)
     SELECT id, 'src/a.ts', 10, 'high', 'bug', '空指针风险', '增加判空' FROM report WHERE task_id = ?`
  ).run(taskId);
  db.prepare(
    `INSERT INTO report_issue (report_id, file, line, severity, category, description, suppressed)
     SELECT id, 'src/b.ts', 20, 'low', 'style', '已被抑制的条目', 1 FROM report WHERE task_id = ?`
  ).run(taskId);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ShareService', () => {
  it('ensure 幂等，重复调用返回同一 token', () => {
    const a = svc.ensure(taskId);
    const b = svc.ensure(taskId);
    expect(a.token).toBe(b.token);
    expect(a.token.length).toBeGreaterThan(20);
  });

  it('任务不存在时 404', () => {
    expect(() => svc.ensure(99999)).toThrowError(ShareError);
  });

  it('sharedReport：token 正确返回任务+报告+未抑制问题', () => {
    const token = svc.ensure(taskId).token;
    const view = svc.sharedReport(token)!;
    expect(view.task.node).toBe('42');
    expect(view.task.author).toBe('zhangsan5');
    expect(view.task.commitMessage).toBe('修复超时');
    expect(view.report.summary).toBe('测试摘要');
    expect(view.issues).toHaveLength(1);
    expect(view.issues[0].description).toBe('空指针风险');
    expect(view.issues[0].suggestion).toBe('增加判空');
  });

  it('错误 / 空 token 返回 null', () => {
    expect(svc.sharedReport('no-such-token')).toBeNull();
    expect(svc.sharedReport('')).toBeNull();
  });

  it('rotate 换新 token，旧 token 失效', () => {
    const old = svc.ensure(taskId).token;
    const row = svc.rotate(taskId);
    expect(row.token).not.toBe(old);
    expect(row.rotated_at).toBeTruthy();
    expect(svc.sharedReport(old)).toBeNull();
    expect(svc.sharedReport(row.token)).not.toBeNull();
  });

  it('revoke 后所有链接失效，再次 revoke 404', () => {
    svc.revoke(taskId);
    expect(svc.get(taskId)).toBeUndefined();
    expect(() => svc.rotate(taskId)).toThrowError(ShareError);
    expect(() => svc.revoke(taskId)).toThrowError(ShareError);
  });

  it('taskIdFor 解析与查空', () => {
    svc.ensure(taskId);
    expect(svc.taskIdFor(svc.get(taskId)!.token)).toBe(taskId);
    expect(svc.taskIdFor('bogus')).toBeUndefined();
  });
});
