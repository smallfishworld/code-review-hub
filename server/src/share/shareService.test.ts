import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { ReportService } from '../tasks/reportService.js';
import { buildAuthRoutes } from '../auth/authRoutes.js';
import { MemoryStore } from '../memory/store.js';
import { ShareService, ShareError } from './shareService.js';
import { buildShareRoutes } from './shareRoutes.js';

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
  db.prepare(
    "INSERT INTO repo (id, type, name, url) VALUES (1, 'git', 'demo-repo', 'https://example.com/demo.git')"
  ).run();
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

  it('评审失败（无 report 行）时返回任务错误信息而不是 404', () => {
    const info = db
      .prepare(
        `INSERT INTO task (repo_id, node, trigger, status, author, error, commit_message)
         VALUES (1, '43', 'auto', 'failed', 'lisi', '模型调用超时', '调整配置')`
      )
      .run();
    const failedTaskId = Number(info.lastInsertRowid);
    const token = svc.ensure(failedTaskId).token;
    const view = svc.sharedReport(token);
    expect(view).not.toBeNull();
    expect(view!.task.status).toBe('failed');
    expect(view!.task.error).toBe('模型调用超时');
    expect(view!.report).toBeNull();
    expect(view!.issues).toEqual([]);
  });
});

describe('share routes with auth guard + memory feedback', () => {
  it('匿名访问分享页并提交误报 / 已修复 / 不修复可写入项目记忆且拒绝冲突标记', async () => {
    const app = Fastify({ trustProxy: true });
    const auth = buildAuthRoutes(db, { loginRequired: true });
    auth.register(app);
    auth.auth.bootstrapAdminForTest('admin', 'AdminPass123!');
    const share = buildShareRoutes(db, reports, { baseUrl: 'http://localhost:3000', dataDir: dir });
    share.register(app);
    await app.ready();

    try {
      // 插入一个带 3 条缺陷的成功任务
      const info = db
        .prepare(
          `INSERT INTO task (repo_id, node, trigger, status, author)
           VALUES (1, '44', 'manual', 'succeeded', 'wangwu')`
        )
        .run();
      const tid = Number(info.lastInsertRowid);
      const rInfo = db
        .prepare(
          `INSERT INTO report (task_id, summary, issue_count, raw_path, parsed_ok)
           VALUES (?, '发现 3 个问题', 3, 'nonexistent.json', 1)`
        )
        .run(tid);
      const reportId = Number(rInfo.lastInsertRowid);
      const insertIssue = db.prepare(
        `INSERT INTO report_issue (report_id, file, line, severity, category, description)
         VALUES (?, ?, ?, 'high', 'bug', ?)`
      );
      const fpIssueId = Number(insertIssue.run(reportId, 'src/fp.ts', 10, '误报缺陷').lastInsertRowid);
      const fixedIssueId = Number(insertIssue.run(reportId, 'src/fix.ts', 20, '已修复缺陷').lastInsertRowid);
      const wfIssueId = Number(insertIssue.run(reportId, 'src/wf.ts', 30, '不修复缺陷').lastInsertRowid);

      const token = share.service.ensure(tid).token;

      // 管理接口仍受保护
      expect((await app.inject({ method: 'GET', url: `/api/tasks/${tid}/share` })).statusCode).toBe(401);

      // 分享接口免登录可访问
      const getRes = await app.inject({ method: 'GET', url: `/api/share/${token}/report` });
      expect(getRes.statusCode).toBe(200);
      expect((getRes.json() as { issues: unknown[] }).issues).toHaveLength(3);

      // 1. 误报 -> suppression（带匿名操作人姓名与客户端设备信息）
      const fpRes = await app.inject({
        method: 'POST',
        url: `/api/share/${token}/feedback`,
        headers: { 'x-forwarded-for': '10.0.0.88', 'user-agent': 'TestBrowser/1.0' },
        payload: {
          issueId: fpIssueId,
          verdict: 'false_positive',
          note: '上游已校验',
          operatorName: 'dev-pc\\zhangsan',
          clientInfo: 'macOS / zh-CN',
        },
      });
      expect(fpRes.statusCode).toBe(200);
      expect((fpRes.json() as { memoryId: number | null }).memoryId).not.toBeNull();

      // 验证分享报告返回了操作人、IP 与设备信息
      const afterFp = (
        await app.inject({ method: 'GET', url: `/api/share/${token}/report` })
      ).json() as {
        issues: { id: number; feedback?: { operatorName?: string; clientIp?: string; clientInfo?: string } }[];
      };
      const fpView = afterFp.issues.find((i) => i.id === fpIssueId);
      expect(fpView?.feedback?.operatorName).toBe('dev-pc\\zhangsan');
      expect(fpView?.feedback?.clientIp).toBe('10.0.0.88');
      expect(fpView?.feedback?.clientInfo).toContain('macOS / zh-CN');

      // 2. 已修复 -> history
      const fixedRes = await app.inject({
        method: 'POST',
        url: `/api/share/${token}/feedback`,
        payload: { issueId: fixedIssueId, verdict: 'fixed' },
      });
      expect(fixedRes.statusCode).toBe(200);
      expect((fixedRes.json() as { memoryId: number | null }).memoryId).not.toBeNull();

      // 3. 不修复 -> pitfall（缺少原因 400，带原因 200）
      const wfBad = await app.inject({
        method: 'POST',
        url: `/api/share/${token}/feedback`,
        payload: { issueId: wfIssueId, verdict: 'wont_fix', note: '   ' },
      });
      expect(wfBad.statusCode).toBe(400);

      const wfRes = await app.inject({
        method: 'POST',
        url: `/api/share/${token}/feedback`,
        payload: { issueId: wfIssueId, verdict: 'wont_fix', note: '兼容旧客户端' },
      });
      expect(wfRes.statusCode).toBe(200);
      expect((wfRes.json() as { memoryId: number | null }).memoryId).not.toBeNull();

      // 冲突标记返回 409
      const conflictRes = await app.inject({
        method: 'POST',
        url: `/api/share/${token}/feedback`,
        payload: { issueId: fixedIssueId, verdict: 'false_positive' },
      });
      expect(conflictRes.statusCode).toBe(409);

      // 验证三条都已写入项目记忆
      const store = new MemoryStore(db, dir);
      const kinds = store.list(1, { status: 'active' }).map((m) => m.kind).sort();
      expect(kinds).toEqual(['history', 'pitfall', 'suppression']);
    } finally {
      await app.close();
    }
  });
});
