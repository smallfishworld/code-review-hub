import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ReportService } from '../tasks/reportService.js';

/**
 * Report share tokens (access control, phase 2).
 *
 * A share token grants read-only access to exactly one task's report via
 * `/api/share/:token/report` — no other API, no console pages. Tokens do
 * NOT expire: pushed messages are archival (recipients may open the link
 * weeks later). A leaked link is handled by rotating the token, which
 * invalidates all previously pushed URLs for that task.
 */
export class ShareError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
  }
}

interface ShareRow {
  task_id: number;
  token: string;
  created_at: string;
  rotated_at: string | null;
}

export class ShareService {
  constructor(
    private readonly db: Database.Database,
    private readonly reports: ReportService
  ) {}

  /** The token row for a task, if one exists. */
  get(taskId: number): ShareRow | undefined {
    return this.db
      .prepare('SELECT * FROM report_share WHERE task_id = ?')
      .get(taskId) as ShareRow | undefined;
  }

  /** Create a token for a task (idempotent; returns the existing one). */
  ensure(taskId: number): ShareRow {
    const existing = this.get(taskId);
    if (existing) return existing;
    if (!this.db.prepare('SELECT 1 FROM task WHERE id = ?').get(taskId)) {
      throw new ShareError('任务不存在', 404);
    }
    const token = randomBytes(24).toString('base64url');
    this.db
      .prepare('INSERT INTO report_share (task_id, token) VALUES (?, ?)')
      .run(taskId, token);
    return this.get(taskId)!;
  }

  /** Invalidate the old token and mint a fresh one. */
  rotate(taskId: number): ShareRow {
    const existing = this.get(taskId);
    if (!existing) throw new ShareError('该任务没有分享链接', 404);
    const token = randomBytes(24).toString('base64url');
    this.db
      .prepare(
        `UPDATE report_share
         SET token = ?, rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE task_id = ?`
      )
      .run(token, taskId);
    return this.get(taskId)!;
  }

  /** Remove the share link entirely (previously pushed URLs stop working). */
  revoke(taskId: number): void {
    const info = this.db.prepare('DELETE FROM report_share WHERE task_id = ?').run(taskId);
    if (info.changes === 0) throw new ShareError('该任务没有分享链接', 404);
  }

  /** Resolve a token to its task id; undefined when unknown/revoked. */
  taskIdFor(token: string): number | undefined {
    const row = this.db
      .prepare('SELECT task_id FROM report_share WHERE token = ?')
      .get(token) as { task_id: number } | undefined;
    return row?.task_id;
  }

  /** Public share view of a report: task metadata + report/issues (no raw JSON). */
  sharedReport(token: string): {
    task: {
      id: number;
      node: string;
      status: string;
      author: string | null;
      error: string | null;
      commitMessage: string | null;
      commitDate: string | null;
      createdAt: string;
    };
    repo: { name: string; url: string; type: string };
    report: { summary: string | null; issueCount: number; parsedOk: boolean; createdAt: string } | null;
    issues: {
      id: number;
      file: string | null;
      line: number | null;
      endLine: number | null;
      severity: string | null;
      category: string | null;
      description: string;
      suggestion: string | null;
      feedback?: {
        verdict: string;
        note: string | null;
        operatorName?: string | null;
        clientIp?: string | null;
        clientInfo?: string | null;
      };
    }[];
  } | null {
    const taskId = this.taskIdFor(token);
    if (taskId === undefined) return null;
    const task = this.db
      .prepare(
        'SELECT id, repo_id, node, status, author, error, commit_message, commit_date, created_at FROM task WHERE id = ?'
      )
      .get(taskId) as
      | {
          id: number; repo_id: number; node: string; status: string; author: string | null;
          error: string | null; commit_message: string | null; commit_date: string | null; created_at: string;
        }
      | undefined;
    if (!task) return null;
    const report = this.reports.get(taskId);
    const repo = this.db
      .prepare('SELECT name, url, type FROM repo WHERE id = ?')
      .get(task.repo_id) as { name: string; url: string; type: string } | undefined;

    // Existing verdicts so the share page can show what was already decided.
    const feedbackRows = report
      ? (this.db
          .prepare(
            `SELECT issue_id, verdict, note, operator_name, client_ip, client_info
             FROM review_feedback
             WHERE task_id = ? AND verdict != 'valid' ORDER BY id`
          )
          .all(taskId) as {
          issue_id: number;
          verdict: string;
          note: string | null;
          operator_name: string | null;
          client_ip: string | null;
          client_info: string | null;
        }[])
      : [];
    const feedbackByIssue = new Map(
      feedbackRows.map((f) => [
        f.issue_id,
        {
          verdict: f.verdict,
          note: f.note,
          ...(f.operator_name ? { operatorName: f.operator_name } : {}),
          ...(f.client_ip ? { clientIp: f.client_ip } : {}),
          ...(f.client_info ? { clientInfo: f.client_info } : {}),
        },
      ])
    );

    const issues = report
      ? (this.reports.issues(taskId) ?? []).map((i) => ({
          id: i.id,
          file: i.file,
          line: i.line,
          endLine: i.endLine,
          severity: i.severity,
          category: i.category,
          description: i.description,
          suggestion: i.suggestion,
          ...(feedbackByIssue.has(i.id) ? { feedback: feedbackByIssue.get(i.id) } : {}),
        }))
      : [];
    return {
      task: {
        id: task.id,
        node: task.node,
        status: task.status,
        author: task.author,
        error: task.error,
        commitMessage: task.commit_message,
        commitDate: task.commit_date,
        createdAt: task.created_at,
      },
      repo: {
        name: repo?.name ?? `repo#${task.repo_id}`,
        url: repo?.url ?? '',
        type: repo?.type ?? '',
      },
      report: report
        ? {
            summary: report.summary,
            issueCount: report.issueCount,
            parsedOk: report.parsedOk,
            createdAt: report.createdAt,
          }
        : null,
      issues,
    };
  }
}
