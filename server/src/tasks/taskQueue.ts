import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import type { LogService } from '../logs/logService.js';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type TaskTrigger = 'manual' | 'auto';

export interface TaskRecord {
  id: number;
  repoId: number;
  node: string;
  trigger: TaskTrigger;
  status: TaskStatus;
  author?: string;
  error?: string;
  ocrExitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
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
    author: (row.author as string | null) ?? undefined,
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
 * Scheduling rule: per-repo serial (one task at a time per repo — protects
 * the repo's working copy/clone from concurrent sync), across repos up to
 * `maxConcurrentRepos` in parallel.
 *
 * The actual review work is injected via the `executor` callback, keeping
 * this class testable with a fake `ocr` script and reusable by the monitor.
 */
export class TaskQueue extends EventEmitter {
  private runningRepos = new Set<number>();
  private cancelledTasks = new Set<number>();
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
    private readonly executor: (task: TaskRecord, onSpawn: (child: { kill: (signal?: string) => void }) => void) => Promise<{ exitCode: number; error?: string }>,
    private readonly maxConcurrentRepos = 2,
    /** Runtime log sink (web console); task lifecycle lands here. */
    private readonly logs?: LogService
  ) {
    super();
  }

  /** Stop scheduling new tasks (e.g. before closing the db on shutdown). */
  stop(): void {
    this.stopped = true;
  }

  /** Re-arm after a service restart: stale running -> failed, queued -> requeued. */
  recoverFromRestart(): void {
    this.db
      .prepare(
        `UPDATE task
         SET status = 'failed', error = 'service restarted', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE status = 'running'`
      )
      .run();
    // queued tasks simply stay queued; kick the loop.
    void this.drain();
  }

  /** Enqueue a task. Deduped by (repo, node, trigger) UNIQUE, plus terminal-state handling. */
  enqueue(repoId: number, node: string, trigger: TaskTrigger, author?: string): TaskRecord {
    // Dedup on ACTIVE tasks only (queued/running, partial unique index). A
    // terminal row (succeeded/failed/cancelled) is history, not a lock: the
    // same node can be re-triggered and gets a fresh row. Without this, a
    // cancelled task permanently blocked re-reviewing the node ("取消后无法
    // 再次触发").
    const active = this.db
      .prepare(
        `SELECT * FROM task
         WHERE repo_id = ? AND node = ? AND trigger = ? AND status IN ('queued','running')`
      )
      .get(repoId, node, trigger) as Record<string, unknown> | undefined;
    if (active) return rowToTask(active);
    const info = this.db
      .prepare(
        `INSERT INTO task (repo_id, node, trigger, status, author) VALUES (?, ?, ?, 'queued', ?)`
      )
      .run(repoId, node, trigger, author ?? null);
    const record = this.get(Number(info.lastInsertRowid));
    this.kick();
    return record;
  }

  /** Queue a task only if this repo+node has never been reviewed (any trigger). */
  enqueueIfNew(repoId: number, node: string, trigger: TaskTrigger, author?: string): TaskRecord | null {
    const prior = this.db
      .prepare(
        `SELECT id FROM task WHERE repo_id = ? AND node = ? AND status != 'cancelled'`
      )
      .get(repoId, node);
    if (prior) return null;
    return this.enqueue(repoId, node, trigger, author);
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
      this.cancelledTasks.add(taskId);
      // kill the live child immediately (if any); onSpawn also re-checks
      // cancelledTasks for the spawn-vs-cancel race.
      this.runningHandles.get(taskId)?.kill();
      return true;
    }
    return false;
  }

  isCancelled(taskId: number): boolean {
    return this.cancelledTasks.has(taskId);
  }

  get(taskId: number): TaskRecord {
    const row = this.db.prepare('SELECT * FROM task WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('task not found');
    return rowToTask(row);
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
      if (pending === 0 && this.inFlight === 0 && this.runningRepos.size === 0) return;
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
        if (this.runningRepos.size >= this.maxConcurrentRepos) return;
        // pick the oldest queued task whose repo is not already running
        const candidates = this.db
          .prepare(`SELECT repo_id FROM task WHERE status = 'queued' ORDER BY id`)
          .all() as { repo_id: number }[];
        const nextRepo = candidates.find((c) => !this.runningRepos.has(c.repo_id))?.repo_id;
        if (nextRepo === undefined) return;

        const task = this.db
          .prepare(
            `SELECT * FROM task WHERE status = 'queued' AND repo_id = ? ORDER BY id LIMIT 1`
          )
          .get(nextRepo) as Record<string, unknown> | undefined;
        if (!task) return;
        // cancel raced ahead of scheduling: mark terminal now, don't start
        if (this.cancelledTasks.has(task.id as number)) {
          this.cancelledTasks.delete(task.id as number);
          this.db
            .prepare(
              `UPDATE task SET status = 'cancelled', error = 'cancelled by user',
                 finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
            )
            .run(task.id as number);
          this.emit('completed', { task: this.get(task.id as number) } satisfies TaskCompletedEvent);
          continue;
        }
        void this.runTask(rowToTask(task));
      } catch {
        return;
      }
    }
  }

  private async runTask(task: TaskRecord): Promise<void> {
    this.runningRepos.add(task.repoId);
    this.inFlight++;
    this.logs?.info('task', `#${task.id} 开始评审 repo=${task.repoId} node=${task.node} (${task.trigger})`);
    try {
      this.db
        .prepare(
          `UPDATE task SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
        )
        .run(task.id);

      const onSpawn = (child: { kill: (signal?: string) => void }) => {
        this.runningHandles.set(task.id, child);
        // Kill immediately if cancellation raced ahead of the spawn.
        if (this.cancelledTasks.has(task.id)) child.kill();
      };

      let result: { exitCode: number; error?: string };
      try {
        result = await this.executor(task, onSpawn);
      } catch (err) {
        result = { exitCode: -1, error: err instanceof Error ? err.message : String(err) };
      }

      const cancelled = this.cancelledTasks.has(task.id);
      this.cancelledTasks.delete(task.id);
      const finalStatus: TaskStatus = cancelled
        ? 'cancelled'
        : result.exitCode === 0
          ? 'succeeded'
          : 'failed';
      if (finalStatus === 'succeeded') {
        this.logs?.info('task', `#${task.id} 评审完成`);
      } else if (finalStatus === 'failed') {
        this.logs?.error('task', `#${task.id} 评审失败 (ocr 退出码 ${result.exitCode}): ${result.error ?? '无错误详情'}`);
      } else {
        this.logs?.info('task', `#${task.id} 已取消`);
      }
      try {
        this.db
          .prepare(
            `UPDATE task
             SET status = ?, error = ?, ocr_exit_code = ?,
                 finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE id = ?`
          )
          .run(
            finalStatus,
            cancelled ? 'cancelled by user' : result.error ?? null,
            cancelled ? null : result.exitCode,
            task.id
          );
        const finalTask = this.get(task.id);
        this.emit('completed', { task: finalTask } satisfies TaskCompletedEvent);
      } catch {
        // db closed (e.g. shutdown raced a late completion) — nothing to persist
      }
    } finally {
      this.inFlight--;
      this.runningHandles.delete(task.id);
      this.runningRepos.delete(task.repoId);
      this.kick();
      this.wakeIdleWaiters();
    }
  }
}
