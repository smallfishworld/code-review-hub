import type Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { matchSuppressions } from '../memory/suppressFilter.js';
import type { FeedbackVerdict } from '../memory/feedback.js';
import type { NormalizedReport } from '../engines/types.js';

/**
 * Persists normalized reports and can rebuild indexes from historical ocr JSON.
 *
 * ocr (open-code-review-svn) writes a `jsonOutput` object:
 *   { status, message?, summary?: {files_reviewed, comments, total_tokens,
 *     input_tokens, output_tokens, elapsed, ...}, comments: [{
 *       path, content, suggestion_code?, existing_code?, start_line,
 *       end_line, category?, severity? }], ... }
 *
 * The raw JSON is already stored at `data/reports/<task-id>.json` by the
 * runner (ocr's --output flag). For historical reports, parse failures
 * keep the raw file and mark parsed_ok = 0.
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

/** Tolerant per-issue parsing, with optional validation for new engine output. */
export function parseOcrReport(rawJson: string, requireReview = false): ParsedReport {
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
  if (requireReview && !Array.isArray(data.comments) && !summaryObj) {
    throw new Error('ocr 报告缺少评审摘要或意见列表');
  }
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
  /** Engine that produced the report (null = historical task). */
  engine: string | null;
  createdAt: string;
}

export interface CompletedReviewReport extends NormalizedReport {
  rawPath: string;
  engineName: string;
}

interface IssueFeedback {
  verdict: Exclude<FeedbackVerdict, 'valid'>;
  note: string | null;
}

export interface StoredIssue {
  id: number;
  file: string | null;
  line: number | null;
  /** Optional end line (engines that report a range). */
  endLine: number | null;
  severity: string | null;
  /** ocr issue category (bug/security/performance/maintainability/…). */
  category: string | null;
  description: string;
  /** ocr's suggested replacement code, when provided. */
  suggestion: string | null;
  /** Deterministic suppression marker + the memory entry that matched. */
  suppressed: boolean;
  suppressedBy: number | null;
}

function rowToReport(row: Record<string, unknown>): StoredReport {
  return {
    taskId: row.task_id as number,
    summary: (row.summary as string | null) ?? null,
    issueCount: row.issue_count as number,
    rawPath: row.raw_path as string,
    parsedOk: row.parsed_ok === 1,
    engine: (row.engine as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

export class ReportService {
  constructor(private readonly db: Database.Database) {}

  /** Persist the adapter's normalized result as part of the task's terminal transaction. */
  indexNormalizedReport(taskId: number, report: CompletedReviewReport): StoredReport {
    if (!statSync(report.rawPath, { throwIfNoEntry: false })?.isFile()) throw new Error('报告文件不存在');
    const comments = report.issues.map((issue): ReportComment => ({
      path: issue.file,
      content: issue.description,
      suggestion: issue.suggestion,
      startLine: issue.startLine,
      endLine: issue.endLine,
      severity: issue.severity,
      category: issue.category,
    }));
    this.upsert(taskId, report.rawPath, report.summary, comments.length, true, comments, report.engineName);
    this.updateSuppressedCount(taskId);
    return this.get(taskId)!;
  }

  /** Reconcile tasks completed by earlier versions before report indexing was atomic. */
  recoverLegacyIndexes(dataDir: string): void {
    const tasks = this.db.prepare(
      `SELECT task.id FROM task LEFT JOIN report ON report.task_id = task.id
       WHERE task.status = 'succeeded' AND report.id IS NULL`
    ).all() as { id: number }[];
    for (const { id } of tasks) {
      if (this.indexTaskReport(id, join(dataDir, 'reports', `${id}.json`))) continue;
      this.db.prepare("UPDATE task SET status = 'failed', error = '历史评审报告缺失' WHERE id = ?").run(id);
    }
  }

  /**
   * Parse the raw report file of a finished task and index it, then apply
   * deterministic suppression (project-memory spec): issues matching an
   * active suppression fingerprint are flagged (suppressed=1 + suppressed_by)
   * and excluded from issue_count. Safe to call for failed tasks (no report
   * file → no-op).
   */
  indexTaskReport(taskId: number, rawPath: string): StoredReport | null {
    if (!existsSync(rawPath)) return null;
    let raw: string;
    try {
      raw = readFileSync(rawPath, 'utf8');
    } catch {
      // unreadable file: record as unparsed so the UI can flag it
      return this.upsert(taskId, rawPath, null, 0, false, undefined, this.engineNameOf(taskId));
    }

    try {
      const parsed = parseOcrReport(raw);
      const engineName = this.engineNameOf(taskId);
      this.upsert(taskId, rawPath, parsed.summary, parsed.comments.length, true, parsed.comments, engineName);
      this.updateSuppressedCount(taskId);
      return this.get(taskId);
    } catch {
      // succeeded-but-raw: keep the file, index as unparsed
      return this.upsert(
        taskId,
        rawPath,
        `报告解析失败（原文已保留）: ${raw.slice(0, 200)}`,
        0,
        false,
        undefined,
        this.engineNameOf(taskId)
      );
    }
  }

  private updateSuppressedCount(taskId: number): void {
    const count = this.applySuppression(taskId);
    if (count > 0) {
      this.db.prepare('UPDATE report SET issue_count = MAX(0, issue_count - ?) WHERE task_id = ?')
        .run(count, taskId);
    }
  }

  /** Engine display name for a task (null → 历史任务，报告页显示 ocr（历史）). */
  private engineNameOf(taskId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT e.name FROM task t JOIN engine e ON e.id = t.engine_id WHERE t.id = ?`
      )
      .get(taskId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /**
   * Deterministic suppression pass over a freshly indexed report: mark issues
   * whose (file + category + description) fingerprint matches an active
   * suppression memory. Returns the number of suppressed issues.
   */
  private applySuppression(taskId: number): number {
    const report = this.get(taskId);
    if (!report) return 0;
    const issues = this.issues(taskId, { includeSuppressed: true });
    if (issues.length === 0) return 0;
    const task = this.db.prepare('SELECT repo_id FROM task WHERE id = ?').get(taskId) as
      | { repo_id: number }
      | undefined;
    if (!task) return 0;
    const matches = matchSuppressions(
      this.db,
      task.repo_id,
      issues.map((i) => ({ file: i.file, category: i.category, description: i.description }))
    );
    const mark = this.db.prepare(
      'UPDATE report_issue SET suppressed = 1, suppressed_by = ? WHERE id = ? AND suppressed = 0'
    );
    let count = 0;
    const tx = this.db.transaction(() => {
      issues.forEach((issue, idx) => {
        const memoryId = matches[idx];
        if (memoryId !== null && memoryId !== undefined) {
          mark.run(memoryId, issue.id);
          count++;
        }
      });
    });
    tx();
    return count;
  }

  /** Insert or replace the report row + issue rows in one transaction. */
  private upsert(
    taskId: number,
    rawPath: string,
    summary: string | null,
    issueCount: number,
    parsedOk: boolean,
    comments?: ReportComment[],
    engineName: string | null = null
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
          `INSERT INTO report (task_id, summary, issue_count, raw_path, parsed_ok, engine)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(taskId, summary, issueCount, rawPath, parsedOk ? 1 : 0, engineName);
      const reportId = Number(info.lastInsertRowid);
      if (comments) {
        const insertIssue = this.db
          .prepare(
            `INSERT INTO report_issue (report_id, file, line, end_line, severity, category, description, suggestion)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          );
        // Engines occasionally emit the same finding twice (observed: ocr's
        // double agent pass records one code_comment per pass). Report views
        // must not show duplicates: identical (file, line, category,
        // normalized description) is collapsed to the first occurrence.
        const seen = new Set<string>();
        let inserted = 0;
        for (const c of comments) {
          const key = [
            (c.path ?? '').replace(/\\/g, '/').trim().toLowerCase(),
            c.startLine ?? c.endLine ?? null,
            (c.category ?? '').trim().toLowerCase(),
            (c.content ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
          ].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          insertIssue.run(
            reportId,
            c.path ?? null,
            c.startLine ?? c.endLine ?? null,
            c.endLine ?? null,
            c.severity ?? null,
            c.category ?? null,
            c.content ?? '',
            c.suggestion ?? null
          );
          inserted++;
        }
        if (inserted !== comments.length) {
          this.db
            .prepare('UPDATE report SET issue_count = ? WHERE id = ?')
            .run(inserted, reportId);
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

  /**
   * Issue list for a task's report. Suppressed issues are hidden by default
   * (报告视图与通知不含被抑制条目); report detail passes includeSuppressed.
   */
  issues(
    taskId: number,
    opts: { includeSuppressed?: boolean } = {}
  ): StoredIssue[] {
    const row = this.db.prepare('SELECT id FROM report WHERE task_id = ?').get(taskId) as
      | { id: number }
      | undefined;
    if (!row) return [];
    const rows = (
      opts.includeSuppressed
        ? this.db
            .prepare('SELECT * FROM report_issue WHERE report_id = ? ORDER BY id')
            .all(row.id)
        : this.db
            .prepare(
              'SELECT * FROM report_issue WHERE report_id = ? AND suppressed = 0 ORDER BY id'
            )
            .all(row.id)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      file: (r.file as string | null) ?? null,
      line: (r.line as number | null) ?? null,
      endLine: (r.end_line as number | null) ?? null,
      severity: (r.severity as string | null) ?? null,
      category: (r.category as string | null) ?? null,
      description: r.description as string,
      suggestion: (r.suggestion as string | null) ?? null,
      suppressed: r.suppressed === 1,
      suppressedBy: (r.suppressed_by as number | null) ?? null,
    }));
  }

  /** Full detail: index row + parsed issues + raw JSON text. */
  detail(taskId: number): {
    report: StoredReport;
    issues: (StoredIssue & { feedback?: IssueFeedback })[];
    suppressedIssues: (StoredIssue & { feedback?: IssueFeedback })[];
    raw: string | null;
  } | null {
    const report = this.get(taskId);
    if (!report) return null;
    let raw: string | null;
    try {
      raw = readFileSync(report.rawPath, 'utf8');
    } catch {
      raw = null;
    }
    const feedbackRows = this.db.prepare(
      "SELECT issue_id, verdict, note FROM review_feedback WHERE task_id = ? AND verdict != 'valid' ORDER BY id"
    ).all(taskId) as ({ issue_id: number } & IssueFeedback)[];
    const feedbackByIssue = new Map(
      feedbackRows.map(({ issue_id, verdict, note }) => [issue_id, { verdict, note }])
    );
    const all = this.issues(taskId, { includeSuppressed: true }).map((issue) => {
      const feedback = feedbackByIssue.get(issue.id);
      return feedback ? { ...issue, feedback } : issue;
    });
    return {
      report,
      issues: all.filter((i) => !i.suppressed),
      suppressedIssues: all.filter((i) => i.suppressed),
      raw,
    };
  }
}
