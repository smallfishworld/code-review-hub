import type Database from 'better-sqlite3';
import { issueFingerprint } from './suppressFilter.js';
import { MemoryStore, type MemoryEntry } from './store.js';

/**
 * Issue feedback loop (project-memory spec): 「误报」aggregates into a
 * suppression entry keyed by fingerprint (feedback_count escalates confidence
 * every 3rd confirmation). 「已修复」writes a history entry, and 「不修复」
 * records an accepted risk as a pitfall. Repeating a verdict is idempotent.
 */

export class FeedbackError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export type FeedbackVerdict = 'false_positive' | 'fixed' | 'valid' | 'wont_fix';

export interface FeedbackOperator {
  userId?: number | null;
  operatorName?: string | null;
  clientIp?: string | null;
  clientInfo?: string | null;
}

export interface FeedbackInput {
  issueId: number;
  verdict: FeedbackVerdict;
  note?: string;
  operator?: FeedbackOperator;
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
  if (input.note != null && typeof input.note !== 'string') {
    throw new FeedbackError('原因必须为文本');
  }
  const note = input.note?.trim();
  if (input.verdict === 'wont_fix' && (!note || note.length > 500)) {
    throw new FeedbackError('请填写不修复原因（1–500 字符）');
  }
  return db.transaction(writeFeedback).immediate(db, store, taskId, { ...input, note });
}

function writeFeedback(
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
      `SELECT ri.id, ri.file, ri.category, ri.description
       FROM report_issue ri JOIN report r ON r.id = ri.report_id
       WHERE ri.id = ? AND r.task_id = ?`
    )
    .get(input.issueId, taskId) as
    | { id: number; file: string | null; category: string | null; description: string }
    | undefined;
  if (!issue) throw new FeedbackError('该任务下不存在此 issue', 404);

  const existing = db
    .prepare(
      `SELECT id, memory_id, verdict FROM review_feedback
       WHERE issue_id = ? AND (verdict = ? OR (verdict != 'valid' AND ? != 'valid'))
       ORDER BY (verdict = ?) DESC, id DESC LIMIT 1`
    )
    .get(input.issueId, input.verdict, input.verdict, input.verdict) as
    | { id: number; memory_id: number | null; verdict: FeedbackVerdict }
    | undefined;
  if (existing) {
    if (existing.verdict !== input.verdict) {
      throw new FeedbackError('此问题已记录其他处理结果', 409);
    }
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
  const description = issue.description.replace(/\s+/g, ' ').trim();
  const noteTitle = input.note?.replace(/\s+/g, ' ');
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
          title: noteTitle || description.slice(0, 60) || '误报模式',
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
      title: noteTitle || description.slice(0, 60) || '已修复问题',
      body: issue.description,
      confidence: 0.6,
      sourceTaskId: taskId,
    });
    memoryId = entry.id;
    action = 'created';
  } else if (input.verdict === 'wont_fix') {
    const reason = (input.note ?? '').split(/\r?\n/).map((line) => `> ${line}`).join('\n');
    const entry = store.create({
      repoId: task.repo_id,
      kind: 'pitfall',
      scope: issue.file?.replace(/\\/g, '/') ?? null,
      title: `不修复 #${issue.id} · ${description.slice(0, 60)}`,
      body: `已确认的问题：${description.slice(0, 300)}\n\n不修复原因：\n${reason}`,
      confidence: 0.7,
      sourceTaskId: taskId,
    });
    memoryId = entry.id;
    action = 'created';
  }

  const op = input.operator;
  const info = db
    .prepare(
      `INSERT INTO review_feedback
         (task_id, issue_id, verdict, memory_id, note, user_id, operator_name, client_ip, client_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      taskId,
      input.issueId,
      input.verdict,
      memoryId,
      input.note ?? null,
      op?.userId && op.userId > 0 ? op.userId : null,
      op?.operatorName?.trim().slice(0, 120) || null,
      op?.clientIp?.trim().slice(0, 80) || null,
      op?.clientInfo?.trim().slice(0, 300) || null
    );
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
