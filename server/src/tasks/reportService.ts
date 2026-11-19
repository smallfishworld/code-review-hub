import type Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Parses ocr's JSON output and persists the report index.
 *
 * ocr (open-code-review-svn) writes a `jsonOutput` object:
 *   { status, message?, summary?: {files_reviewed, comments, total_tokens,
 *     input_tokens, output_tokens, elapsed, ...}, comments: [{
 *       path, content, suggestion_code?, existing_code?, start_line,
 *       end_line, category?, severity? }], ... }
 *
 * The raw JSON is already stored at `data/reports/<task-id>.json` by the
 * runner (ocr's --output flag). This module indexes it into `report` +
 * `report_issue`. Parse failures keep the raw file and mark
 * parsed_ok = 0 ("succeeded-but-raw").
 */

export interface ReportComment {
  path?: string;
  content?: string;
  suggestion?: string;
  startLine?: number;
  endLine?: number;
  severity?: string;
  category?: string;
}

export interface ParsedReport {
  status?: string;
  message?: string;
  /** Human-readable one-line summary derived from ocr output. */
  summary: string;
  issueCount: number;
  comments: ReportComment[];
}

/** Tolerant parse of an ocr JSON report; throws only on unreadable JSON. */
export function parseOcrReport(rawJson: string): ParsedReport {
  const data = JSON.parse(rawJson) as Record<string, unknown>;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('报告根节点不是 JSON 对象');
  }

  const rawComments = Array.isArray(data.comments) ? data.comments : [];
  const comments: ReportComment[] = rawComments
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
    .map((c) => ({
      path: typeof c.path === 'string' ? c.path : undefined,
      content: typeof c.content === 'string' ? c.content : undefined,
      suggestion: typeof c.suggestion_code === 'string' ? c.suggestion_code : undefined,
      startLine: typeof c.start_line === 'number' ? c.start_line : undefined,
      endLine: typeof c.end_line === 'number' ? c.end_line : undefined,
      severity: typeof c.severity === 'string' ? c.severity : undefined,
      category: typeof c.category === 'string' ? c.category : undefined,
    }));

  const summaryObj =
    data.summary !== null && typeof data.summary === 'object' && !Array.isArray(data.summary)
      ? (data.summary as Record<string, unknown>)
      : undefined;
  const filesReviewed = typeof summaryObj?.files_reviewed === 'number' ? summaryObj.files_reviewed : undefined;

  let summary: string;
  const message = typeof data.message === 'string' ? data.message : undefined;
  const status = typeof data.status === 'string' ? data.status : undefined;
  if (message && typeof data.comments !== 'undefined') {
    // ocr provides its own message ("No comments generated. ..." etc.)
    summary = message;
  } else if (rawComments.length === 0) {
    summary = '未发现评审问题';
  } else {
    summary = `发现 ${rawComments.length} 条评审意见`;
  }
  if (filesReviewed !== undefined) {
    summary = `评审 ${filesReviewed} 个文件，${summary}`;
  }
  if (status) summary = `[${status}] ${summary}`;

  return { status, message, summary, issueCount: comments.length, comments };
}

export interface StoredReport {
  taskId: number;
  summary: string | null;
  issueCount: number;
  rawPath: string;
  parsedOk: boolean;
  createdAt: string;
}

export interface StoredIssue {
  id: number;
  file: string | null;
  line: number | null;
  severity: string | null;
  /** ocr issue category (bug/security/performance/maintainability/…). */
  category: string | null;
  description: string;
  /** ocr's suggested replacement code, when provided. */
  suggestion: string | null;
}

function rowToReport(row: Record<string, unknown>): StoredReport {
  return {
    taskId: row.task_id as number,
    summary: (row.summary as string | null) ?? null,
    issueCount: row.issue_count as number,
    rawPath: row.raw_path as string,
    parsedOk: row.parsed_ok === 1,
    createdAt: row.created_at as string,
  };
}

export class ReportService {
  constructor(private readonly db: Database.Database) {}

  /**
   * Parse the raw report file of a finished task and index it.
   * Safe to call for failed tasks (no report file → no-op).
   */
  indexTaskReport(taskId: number, rawPath: string): StoredReport | null {
    if (!existsSync(rawPath)) return null;
    let raw: string;
    try {
      raw = readFileSync(rawPath, 'utf8');
    } catch {
      // unreadable file: record as unparsed so the UI can flag it
      return this.upsert(taskId, rawPath, null, 0, false);
    }

    try {
      const parsed = parseOcrReport(raw);
      return this.upsert(taskId, rawPath, parsed.summary, parsed.issueCount, true, parsed.comments);
    } catch {
      // succeeded-but-raw: keep the file, index as unparsed
      return this.upsert(taskId, rawPath, `报告解析失败（原文已保留）: ${raw.slice(0, 200)}`, 0, false);
    }
  }

  /** Insert or replace the report row + issue rows in one transaction. */
  private upsert(
    taskId: number,
    rawPath: string,
    summary: string | null,
    issueCount: number,
    parsedOk: boolean,
    comments?: ReportComment[]
  ): StoredReport {
    const tx = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM report WHERE task_id = ?').get(taskId) as
        | { id: number }
        | undefined;
      if (existing) {
        this.db.prepare('DELETE FROM report WHERE id = ?').run(existing.id); // cascades issues
      }
      const info = this.db
        .prepare(
          `INSERT INTO report (task_id, summary, issue_count, raw_path, parsed_ok)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(taskId, summary, issueCount, rawPath, parsedOk ? 1 : 0);
      const reportId = Number(info.lastInsertRowid);
      if (comments) {
        const insertIssue = this.db
          .prepare(
            `INSERT INTO report_issue (report_id, file, line, severity, category, description, suggestion)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          );
        for (const c of comments) {
          insertIssue.run(
            reportId,
            c.path ?? null,
            c.startLine ?? c.endLine ?? null,
            c.severity ?? null,
            c.category ?? null,
            c.content ?? '',
            c.suggestion ?? null
          );
        }
      }
    });
    tx();
    return this.get(taskId)!;
  }

  /** Report index row for a task (null if none). */
  get(taskId: number): StoredReport | null {
    const row = this.db.prepare('SELECT * FROM report WHERE task_id = ?').get(taskId) as Record<
      string,
      unknown
    > | undefined;
    return row ? rowToReport(row) : null;
  }

  /** Issue list for a task's report. */
  issues(taskId: number): StoredIssue[] {
    const row = this.db.prepare('SELECT id FROM report WHERE task_id = ?').get(taskId) as
      | { id: number }
      | undefined;
    if (!row) return [];
    const rows = this.db
      .prepare('SELECT * FROM report_issue WHERE report_id = ? ORDER BY id')
      .all(row.id) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      file: (r.file as string | null) ?? null,
      line: (r.line as number | null) ?? null,
      severity: (r.severity as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      description: r.description as string,
      suggestion: (r.suggestion as string | null) ?? null,
    }));
  }

  /** Full detail: index row + parsed issues + raw JSON text. */
  detail(taskId: number): { report: StoredReport; issues: StoredIssue[]; raw: string | null } | null {
    const report = this.get(taskId);
    if (!report) return null;
    let raw: string | null;
    try {
      raw = readFileSync(report.rawPath, 'utf8');
    } catch {
      raw = null;
    }
    return { report, issues: this.issues(taskId), raw };
  }
}
