import type Database from 'better-sqlite3';
import { issueFingerprint } from './suppressFilter.js';
import { MemoryStore, type MemoryEntry } from './store.js';

/**
 * Issue feedback loop (project-memory spec): 「误报」aggregates into a
 * suppression entry keyed by fingerprint (feedback_count escalates confidence
 * every 3rd confirmation); 「已修复」writes a history entry. Every feedback
 * row references the memory entry it created/reinforced (review_feedback
 * .memory_id) — idempotent per (issue_id, verdict).
 */

export class FeedbackError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface FeedbackInput {
  issueId: number;
  verdict: 'false_positive' | 'fixed' | 'valid';
  note?: string;
}

export interface FeedbackOutcome {
  feedbackId: number;
  memoryId: number | null;
  /** What happened to the memory entry: created | reinforced | none. */
  memoryAction: 'created' | 'reinforced' | 'none';
  memory: MemoryEntry | null;
}

const CONFIRM_STEP = 3; // 每 3 次人工确认提升一次置信度
const CONFIDENCE_STEP = 0.1;
const CONFIDENCE_MAX = 0.95;

export function processFeedback(
  db: Database.Database,
  store: MemoryStore,
  taskId: number,
  input: FeedbackInput
): FeedbackOutcome {
  const task = db.prepare('SELECT repo_id FROM task WHERE id = ?').get(taskId) as
    | { repo_id: number }
    | undefined;
  if (!task) throw new FeedbackError('任务不存在', 404);
  const issue = db
    .prepare(
      `SELECT ri.id, ri.report_id, ri.file, ri.category, ri.description
       FROM report_issue ri JOIN report r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.task_id = ?`
    )
    .get(input.issueId, taskId) as
    | { id: number; report_id: number; file: string | null; category: string | null; description: string }
    | undefined;
  if (!issue) throw new FeedbackError('该任务下不存在此 issue', 404);

  const existing = db
    .prepare('SELECT id, memory_id FROM review_feedback WHERE issue_id = ? AND verdict = ?')
    .get(input.issueId, input.verdict) as { id: number; memory_id: number | null } | undefined;
  if (existing) {
    const memory = existing.memory_id ? store.get(existing.memory_id) : null;
    return {
      feedbackId: existing.id,
      memoryId: existing.memory_id,
      memoryAction: 'none',
      memory,
    };
  }

  let memoryId: number | null = null;
  let action: FeedbackOutcome['memoryAction'] = 'none';
  if (input.verdict === 'false_positive') {
    const fp = issueFingerprint({
      file: issue.file,
      category: issue.category,
      description: issue.description,
    });
    if (fp) {
      const found = db
        .prepare(
          `SELECT id FROM memory_entry
           WHERE repo_id = ? AND kind = 'suppression' AND fingerprint = ? AND status IN ('active','archived')
           ORDER BY id LIMIT 1`
        )
        .get(task.repo_id, fp) as { id: number } | undefined;
      if (found) {
        const entry = store.get(found.id)!;
        const count = entry.feedbackCount + 1;
        const confidence =
          count % CONFIRM_STEP === 0
            ? Math.min(CONFIDENCE_MAX, entry.confidence + CONFIDENCE_STEP)
            : entry.confidence;
        store.update(found.id, {
          status: entry.status === 'archived' ? 'active' : entry.status,
          confidence,
        });
        bumpFeedbackCount(db, found.id, count);
        memoryId = found.id;
        action = 'reinforced';
      } else {
        const entry = store.create({
          repoId: task.repo_id,
          kind: 'suppression',
          scope: issue.file ? issue.file.replace(/\\/g, '/').split('/').slice(0, 2).join('/') : null,
          title: input.note?.trim() || issue.description.slice(0, 60) || '误报模式',
          body: issue.description,
          fingerprint: fp,
          confidence: 0.7,
          sourceTaskId: taskId,
        });
        // 新建的 suppression 本身就是第 1 次人工确认
        bumpFeedbackCount(db, entry.id, 1);
        memoryId = entry.id;
        action = 'created';
      }
    }
  } else if (input.verdict === 'fixed') {
    const entry = store.create({
      repoId: task.repo_id,
      kind: 'history',
      scope: issue.file ?? null,
      title: input.note?.trim() || issue.description.slice(0, 60) || '已修复问题',
      body: issue.description,
      confidence: 0.6,
      sourceTaskId: taskId,
    });
    memoryId = entry.id;
    action = 'created';
  }

  const info = db
    .prepare(
      `INSERT INTO review_feedback (task_id, issue_id, verdict, memory_id, note)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(taskId, input.issueId, input.verdict, memoryId, input.note ?? null);
  return {
    feedbackId: Number(info.lastInsertRowid),
    memoryId,
    memoryAction: action,
    memory: memoryId ? store.get(memoryId) : null,
  };
}

function bumpFeedbackCount(db: Database.Database, memoryId: number, count: number): void {
  db.prepare('UPDATE memory_entry SET feedback_count = ? WHERE id = ?').run(count, memoryId);
}
