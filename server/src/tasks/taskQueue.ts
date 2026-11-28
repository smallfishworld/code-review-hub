import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { LogService } from '../logs/logService.js';
import { repoSourceVersion } from '../repos/sourceVersion.js';
import { resolveEngineForRepo } from '../engines/resolver.js';
import { pickProviderForTask } from '../providers/pool.js';
import type { CompletedReviewReport, ReportService } from './reportService.js';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskTrigger = 'manual' | 'auto';

export interface TaskRecord {
  id: number;
  repoId: number;
  node: string;
  trigger: TaskTrigger;
  status: TaskStatus;
  sourceVersion?: number;
  /** Temporary workspace lease supplied to the executor. */
  workspaceSlot?: number;
  monitorRuleId?: number;
  engineId?: number;
  engineSelectionError?: string;
  /** LLM provider (model) this task was assigned at enqueue time. */
  providerId?: number;
  /** Snapshot of the provider's "name · model" at enqueue time. */
  providerLabel?: string;
  author?: string;
  /** Commit log message, snapshotted at enqueue time. */
  commitMessage?: string;
  /** Commit date (ISO), snapshotted at enqueue time. */
  commitDate?: string;
  error?: string;
  ocrExitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

export type TaskSpawnHandler = (child: { kill: (signal?: string) => void }) => void;

export interface TaskExecutionResult {
  exitCode: number;
  error?: string;
  report?: CompletedReviewReport;
}

interface EnqueueContext {
  sourceVersion?: number;
  monitorRuleId?: number;
  /** Commit metadata snapshot (log message + author date) from the VCS log. */
  commit?: { message?: string; date?: string };
}

/** Task reached a terminal state. Payload carries the final record. */
export interface TaskCompletedEvent {
  task: TaskRecord;
}

/** Map a raw DB row (snake_case) to the TaskRecord shape (camelCase). */
function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as number,
    repoId: row.repo_id as number,
    node: row.node as string,
    trigger: row.trigger as TaskTrigger,
    status: row.status as TaskStatus,
    sourceVersion: row.source_version as number,
    monitorRuleId: (row.monitor_rule_id as number | null) ?? undefined,
    engineId: (row.engine_id as number | null) ?? undefined,
    engineSelectionError: (row.engine_selection_error as string | null) ?? undefined,
    providerId: (row.provider_id as number | null) ?? undefined,
    providerLabel: (row.provider_label as string | null) ?? undefined,
    author: (row.author as string | null) ?? undefined,
    commitMessage: (row.commit_message as string | null) ?? undefined,
    commitDate: (row.commit_date as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    ocrExitCode: (row.ocr_exit_code as number | null) ?? undefined,
    startedAt: (row.started_at as string | null) ?? undefined,
    finishedAt: (row.finished_at as string | null) ?? undefined,
    createdAt: row.created_at as string,
  };
}

/**
 * Worker pool executing review tasks.
 *
 * Each task holds a workspace slot under its repository's concurrency limit.
 * The oldest eligible task starts when a slot and global capacity are available.
 *
 * The actual review work is injected via the `executor` callback, keeping
 * this class testable with a fake `ocr` script and reusable by the monitor.
 */
export class TaskQueue extends EventEmitter {
  private readonly workspaceSlots = new Map<number, Set<number>>();
  private readonly runningControllers = new Map<number, AbortController>();
  /** Live kill handles of running tasks (task id -> latest spawned child). */
  private runningHandles = new Map<number, { kill: (signal?: string) => void }>();
  private draining = false;
  /** Kicks requested while a drain pass was already in flight. */
  private pendingKicks = 0;
  /** Set by stop(): no further tasks are picked up. */
  private stopped = false;
  /** Tasks currently executing (between dequeue and terminal update). */
  private inFlight = 0;
  /** Resolvers waiting on idle(); resolved once work drains. */
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly db: Database.Database,
    private readonly executor: (task: TaskRecord, onSpawn: TaskSpawnHandler, signal: AbortSignal) => Promise<TaskExecutionResult>,
    private readonly maxConcurrentTasks = 2,
    /** Runtime log sink (web console); task lifecycle lands here. */
    private readonly logs?: LogService,
    private readonly reports?: ReportService,
    /** Optional backoff between automatic retries (ms); defaults to 0 for tests. */
    private readonly retryDelayMs = 0
  ) {
    super();
  }

  /** Stop scheduling new tasks (e.g. before closing the db on shutdown). */
  stop(): void {
    this.stopped = true;
  }

  /** Re-arm after a service restart: stale running -> failed, queued -> requeued. */
  recoverFromRestart(): void {
    if (this.reports) {
      const staged = this.db.prepare(
        "SELECT id, pending_report FROM task WHERE status = 'running' AND pending_report IS NOT NULL ORDER BY id"
      ).all() as { id: number; pending_report: string }[];
      for (const row of staged) {
        try {
          this.commitReport(row.id, JSON.parse(row.pending_report) as CompletedReviewReport);
        } catch (err) {
          this.finish(row.id, 'failed', this.reportError(err), 0);
        }
        this.emit('completed', { task: this.get(row.id) } satisfies TaskCompletedEvent);
      }
    }
    this.db
      .prepare(
        `UPDATE task
         SET status = 'failed', error = 'service restarted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE status = 'running'`
      )
      .run();
    // queued tasks simply stay queued; kick the loop.
    this.kick();
  }

  /** Enqueue a task. Deduped by (repo, node, trigger) UNIQUE, plus terminal-state handling. */
  enqueue(
    repoId: number, node: string, trigger: TaskTrigger, author?: string, context: EnqueueContext = {}
  ): TaskRecord {
    const sourceVersion = context.sourceVersion ?? repoSourceVersion(this.db, repoId) ?? 0;
    // Dedup on ACTIVE tasks only (queued/running, partial unique index). A
    // terminal row (succeeded/failed/cancelled) is history, not a lock: the
    // same node can be re-triggered and gets a fresh row. Without this, a
    // cancelled task permanently blocked re-reviewing the node ("取消后无法
    // 再次触发").
    const active = this.db
      .prepare(
        `SELECT * FROM task
         WHERE repo_id = ? AND source_version = ? AND node = ? AND trigger = ? AND status IN ('queued','running')`
      )
      .get(repoId, sourceVersion, node, trigger) as Record<string, unknown> | undefined;
    if (active) return rowToTask(active);
    const monitorRuleId = trigger === 'auto' ? context.monitorRuleId : undefined;
    const commitMessage = context.commit?.message ?? null;
    const commitDate = context.commit?.date ?? null;
    let engineId: number | null = null;
    let engineSelectionError: string | null = null;
    try {
      engineId = resolveEngineForRepo(this.db, repoId, monitorRuleId).row.id;
    } catch (err) {
      engineSelectionError = err instanceof Error ? err.message : String(err);
    }
    // Bind the model NOW (not at execution): concurrent reviews of this repo
    // spread across the pool by current load, and the assignment is persisted
    // so a restart/retry keeps the same model. No pool -> null -> the
    // executor falls back to the global default provider.
    const provider = pickProviderForTask(this.db, repoId);
    const info = this.db
      .prepare(
        `INSERT INTO task (repo_id, source_version, node, trigger, status, author, monitor_rule_id, engine_id, engine_selection_error, provider_id, provider_label, commit_message, commit_date)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        repoId, sourceVersion, node, trigger, author ?? null, monitorRuleId ?? null,
        engineId, engineSelectionError,
        provider?.providerId ?? null, provider?.label ?? null,
        commitMessage, commitDate
      );
    const record = this.get(Number(info.lastInsertRowid));
    this.kick();
    return record;
  }

  /** Manual retries can resume a failed review. Automatic polling deduplicates every attempt. */
  enqueueIfNew(
    repoId: number, node: string, trigger: TaskTrigger, author?: string, context: EnqueueContext = {}
  ): TaskRecord | null {
    const sourceVersion = context.sourceVersion ?? repoSourceVersion(this.db, repoId) ?? 0;
    const prior = this.db
      .prepare(
        `SELECT id FROM task
         WHERE repo_id = ? AND source_version = ? AND node = ? AND status != 'cancelled'
           AND (? = 'auto' OR status != 'failed')`
      )
      .get(repoId, sourceVersion, node, trigger);
    if (prior) return null;
    return this.enqueue(repoId, node, trigger, author, { ...context, sourceVersion });
  }

  cancel(taskId: number): boolean {
    const task = this.db.prepare('SELECT * FROM task WHERE id = ?').get(taskId) as
      | TaskRecord
      | undefined;
    if (!task) return false;
    if (task.status === 'queued') {
      this.db
        .prepare(
          `UPDATE task SET status = 'cancelled', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        )
        .run(taskId);
      this.emit('completed', { task: this.get(taskId) } satisfies TaskCompletedEvent);
      return true;
    }
    if (task.status === 'running') {
      const controller = this.runningControllers.get(taskId);
      if (!controller) return false;
      controller.abort(new Error('cancelled by user'));
      // kill the live child immediately (if any); onSpawn also re-checks
      // the cancellation signal for the spawn-vs-cancel race.
      this.runningHandles.get(taskId)?.kill();
      return true;
    }
    return false;
  }

  /**
   * Cancel every queued/running task of a repository (used when the repo is
   * deleted). Queued tasks flip to cancelled directly; running tasks get the
   * same abort+kill treatment as a user cancel. Returns how many were active.
   */
  cancelByRepo(repoId: number): number {
    const active = this.db
      .prepare(`SELECT id, status FROM task WHERE repo_id = ? AND status IN ('queued','running')`)
      .all(repoId) as { id: number; status: TaskStatus }[];
    let n = 0;
    for (const t of active) {
      if (this.cancel(t.id)) n++;
    }
    return n;
  }

  get(taskId: number): TaskRecord {
    const task = this.find(taskId);
    if (!task) throw new Error('task not found');
    return task;
  }

  find(taskId: number): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM task WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
  }

  list(filter: {
    repoId?: number;
    repoType?: 'svn' | 'git';
    node?: string;
    author?: string;
    status?: TaskStatus;
    trigger?: TaskTrigger;
    limit?: number;
    offset?: number;
  }): { total: number; items: TaskRecord[] } {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (filter.repoId !== undefined) {
      conds.push('repo_id = ?');
      params.push(filter.repoId);
    }
    if (filter.repoType) {
      // repo_id is a soft reference (history survives repo deletion), so a
      // join is required rather than a denormalised column.
      conds.push('repo_id IN (SELECT id FROM repo WHERE type = ?)');
      params.push(filter.repoType);
    }
    if (filter.node) {
      conds.push('node LIKE ?');
      params.push(`%${filter.node}%`);
    }
    if (filter.author) {
      conds.push('author = ?');
      params.push(filter.author);
    }
    if (filter.status) {
      conds.push('status = ?');
      params.push(filter.status);
    }
    if (filter.trigger) {
      conds.push('trigger = ?');
      params.push(filter.trigger);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM task ${where}`).get(...params) as { n: number }
    ).n;
    const items = this.db
      .prepare(`SELECT * FROM task ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as Record<string, unknown>[];
    return { total, items: items.map(rowToTask) };
  }

  /** Kick scheduling (called after enqueue / task completion / restart).
   *  Coalesces concurrent calls; always re-arms at least once more after a
   *  drain pass finishes, so a kick landing mid-drain is never lost. */
  kick(): void {
    this.pendingKicks++;
    if (this.draining) return;
    this.draining = true;
    const loop = async (): Promise<void> => {
      for (;;) {
        this.pendingKicks = 0;
        await this.drain();
        if (this.pendingKicks === 0) return;
      }
    };
    void loop().finally(() => {
      this.draining = false;
      if (this.pendingKicks > 0) this.kick();
    });
  }

  /** Wait until no task is queued or in flight (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const pending = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM task WHERE status IN ('queued','running')`)
          .get() as { n: number }
      ).n;
      if (pending === 0 && this.inFlight === 0) return;
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
        setTimeout(resolve, 25); // safety valve if no further events fire
      });
    }
  }

  private wakeIdleWaiters(): void {
    const waiters = this.idleWaiters.splice(0);
    for (const w of waiters) w();
  }

  private async drain(): Promise<void> {
    for (;;) {
      // The db may be closed between this drain pass and its first query
      // (e.g. tests finishing once idle() resolves); a stop()ped queue
      // must not throw unhandled.
      if (this.stopped) return;
      try {
        if (this.inFlight >= this.maxConcurrentTasks) return;
        // Keep tasks for deleted repositories eligible so the executor can
        // fail them explicitly rather than leaving them stranded in the queue.
        const candidates = this.db
          .prepare(
            `SELECT MIN(t.id) AS task_id, t.repo_id, COALESCE(r.review_concurrency, 1) AS review_concurrency
             FROM task t LEFT JOIN repo r ON r.id = t.repo_id
             WHERE t.status = 'queued'
             GROUP BY t.repo_id, r.review_concurrency
             ORDER BY task_id`
          )
          .all() as { task_id: number; repo_id: number; review_concurrency: number }[];
        const next = candidates.find((candidate) =>
          (this.workspaceSlots.get(candidate.repo_id)?.size ?? 0) < candidate.review_concurrency
        );
        if (!next) return;

        const task = this.get(next.task_id);
        const slots = this.workspaceSlots.get(task.repoId) ?? new Set<number>();
        let slot = 0;
        while (slots.has(slot)) slot++;
        slots.add(slot);
        this.workspaceSlots.set(task.repoId, slots);
        void this.runTask(task, slot, slots);
      } catch {
        return;
      }
    }
  }

  private async runTask(task: TaskRecord, workspaceSlot: number, slots: Set<number>): Promise<void> {
    const controller = new AbortController();
    this.runningControllers.set(task.id, controller);
    this.inFlight++;
    this.logs?.info('task', `#${task.id} 开始评审 repo=${task.repoId} node=${task.node} (${task.trigger})`);
    try {
      this.db
        .prepare(
          `UPDATE task SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        )
        .run(task.id);

      const onSpawn: TaskSpawnHandler = (child) => {
        this.runningHandles.set(task.id, child);
        // Kill immediately if cancellation raced ahead of the spawn.
        if (controller.signal.aborted) child.kill();
      };

      const maxRetries = this.getAutoRetryCount();
      let finalStatus: TaskStatus = 'failed';
      let error: string | null = null;
      let exitCode: number | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          if (controller.signal.aborted) break;
          this.logs?.warn('task', `#${task.id} 评审失败，正在进行第 ${attempt}/${maxRetries} 次自动重试`);
        }

        let result: TaskExecutionResult;
        try {
          result = await this.executor({ ...task, workspaceSlot }, onSpawn, controller.signal);
        } catch (err) {
          result = { exitCode: -1, error: err instanceof Error ? err.message : String(err) };
        }

        if (controller.signal.aborted) {
          finalStatus = 'cancelled';
          error = 'cancelled by user';
          exitCode = null;
          break;
        }

        exitCode = result.exitCode;
        error = result.error ?? null;
        if (result.exitCode === 0) {
          if (this.reports) {
            try {
              if (!result.report) throw new Error('引擎未生成报告');
              this.db.prepare('UPDATE task SET pending_report = ? WHERE id = ?')
                .run(JSON.stringify(result.report), task.id);
              this.commitReport(task.id, result.report);
              finalStatus = 'succeeded';
              error = null;
              break;
            } catch (err) {
              finalStatus = 'failed';
              error = this.reportError(err);
            }
          } else {
            finalStatus = 'succeeded';
            error = null;
            break;
          }
        } else {
          finalStatus = 'failed';
        }

        if (attempt < maxRetries) {
          this.logs?.warn(
            'task',
            `#${task.id} 第 ${attempt + 1} 次尝试失败（${error ?? `exit=${exitCode}`}），准备重试`
          );
          if (this.retryDelayMs > 0) {
            await sleepWithSignal(this.retryDelayMs, controller.signal);
            if (controller.signal.aborted) {
              finalStatus = 'cancelled';
              error = 'cancelled by user';
              exitCode = null;
              break;
            }
          }
        }
      }

      try {
        if (finalStatus !== 'succeeded' || !this.reports) {
          this.finish(task.id, finalStatus, error, finalStatus === 'cancelled' ? null : exitCode);
        }
        if (finalStatus === 'succeeded') this.logs?.info('task', `#${task.id} 评审完成`);
        else if (finalStatus === 'cancelled') this.logs?.info('task', `#${task.id} 已取消`);
        else {
          const retryNote = maxRetries > 0 ? `（已自动重试 ${maxRetries} 次仍失败）` : '';
          this.logs?.error('task', `#${task.id} 评审失败${retryNote}: ${error ?? '无错误详情'}`);
        }
        const finalTask = this.get(task.id);
        this.emit('completed', { task: finalTask } satisfies TaskCompletedEvent);
      } catch {
        // db closed (e.g. shutdown raced a late completion) — nothing to persist
      }
    } finally {
      this.inFlight--;
      this.runningControllers.delete(task.id);
      this.runningHandles.delete(task.id);
      slots.delete(workspaceSlot);
      if (slots.size === 0) this.workspaceSlots.delete(task.repoId);
      this.kick();
      this.wakeIdleWaiters();
    }
  }

  private getAutoRetryCount(): number {
    try {
      const row = this.db
        .prepare("SELECT value FROM setting WHERE key = 'review_auto_retries'")
        .get() as { value: string } | undefined;
      const n = Number(row?.value ?? 0);
      if (!Number.isFinite(n)) return 0;
      return Math.min(5, Math.max(0, Math.floor(n)));
    } catch {
      return 0;
    }
  }

  private finish(taskId: number, status: TaskStatus, error: string | null, exitCode: number | null): void {
    this.db.prepare(
      `UPDATE task SET status = ?, error = ?, ocr_exit_code = ?, pending_report = NULL,
         finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(status, error, exitCode, taskId);
  }

  private commitReport(taskId: number, report: CompletedReviewReport): void {
    this.db.transaction(() => {
      this.reports!.indexNormalizedReport(taskId, report);
      this.finish(taskId, 'succeeded', null, 0);
    })();
  }

  private reportError(error: unknown): string {
    return `评审报告保存失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
