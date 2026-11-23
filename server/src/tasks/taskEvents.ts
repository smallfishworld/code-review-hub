import type Database from 'better-sqlite3';
import type { TaskQueue, TaskCompletedEvent } from './taskQueue.js';
import type { ReportService } from './reportService.js';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { CredentialService } from '../crypto/credentialService.js';
import { MemoryStore } from '../memory/store.js';
import { runDistillation } from '../memory/distill.js';
import { recordMcpToolStats } from '../mcp/injector.js';
import { bumpReviewCount, runCompaction } from '../memory/evolve.js';

/**
 * Task-completion hook: records engine-reported MCP tool stats,
 * fans the terminal-state event out to subscribers (notifications),
 * and kicks async memory distillation for successful reviews.
 *
 * All listeners run asynchronously and failures are isolated — a broken
 * listener must never affect task status or other listeners.
 */

export type TaskTerminalListener = (event: TaskCompletedEvent) => void;

export class TaskEventHub extends EventEmitter {
  private memory?: MemoryStore;

  constructor(
    private readonly db: Database.Database,
    private readonly queue: TaskQueue,
    private readonly reports: ReportService,
    private readonly dataDir: string,
    private readonly credentials?: CredentialService
  ) {
    super();
  }

  /** Attach to the queue; call once at startup. */
  start(): void {
    if (this.credentials) this.memory = new MemoryStore(this.db, this.dataDir);
    this.queue.on('completed', (event: TaskCompletedEvent) => {
      if (event.task.status === 'succeeded') {
        const report = this.reports.get(event.task.id);
        if (report) this.collectMcpStats(event.task.id, report.rawPath);
      }
      this.notifyListeners(event);
      this.distill(event);
    });
  }

  /** Register a terminal-state listener (e.g. notification sender). */
  onTerminal(listener: TaskTerminalListener): void {
    this.on('terminal', listener);
  }

  /** Engine-reported MCP tool stats land on the injection audit rows. */
  private collectMcpStats(taskId: number, rawPath: string): void {
    try {
      const raw = readFileSyncCompat(rawPath);
      if (!raw) return;
      const data = JSON.parse(raw) as Record<string, unknown>;
      const stats = (data.mcp_stats ?? data.tool_calls) as
        | Record<string, { calls?: number; failures?: number }>
        | undefined;
      if (!stats || typeof stats !== 'object') return;
      const normalized: Record<string, { calls: number; failures: number }> = {};
      for (const [tool, s] of Object.entries(stats)) {
        if (!s || typeof s !== 'object') continue;
        normalized[tool] = { calls: Number(s.calls ?? 0), failures: Number(s.failures ?? 0) };
      }
      recordMcpToolStats(this.db, taskId, normalized);
    } catch {
      // 引擎未上报统计属正常情况（tool_stats 保持 NULL → UI 标注）
    }
  }

  private distill(event: TaskCompletedEvent): void {
    if (!this.memory || !this.credentials) return;
    if (event.task.status !== 'succeeded') return;
    try {
      bumpReviewCount(this.db, event.task.repoId);
      runCompaction(this.db, this.memory, event.task.repoId);
    } catch {
      // Memory bookkeeping cannot affect the completed task.
    }
    void runDistillation(this.db, this.credentials, this.memory, {
      repoId: event.task.repoId,
      taskId: event.task.id,
      providerId: event.task.providerId,
      changedFiles: [],
      issueSummaries: this.issueSummaries(event.task.id),
    }).catch(() => {});
  }

  private issueSummaries(taskId: number): string[] {
    try {
      const issues = this.reports.issues(taskId);
      return issues.slice(0, 20).map((i) => {
        const file = i.file ?? '未知文件';
        return `- [${i.severity ?? '无级别'}] ${file}${i.line ? ':' + i.line : ''} ${i.description.slice(0, 200)}`;
      });
    } catch {
      return [];
    }
  }

  private notifyListeners(event: TaskCompletedEvent): void {
    // succeeded/failed/cancelled are all terminal; subscribers filter
    // further (e.g. notification trigger rules).
    for (const listener of this.listeners('terminal')) {
      try {
        // async fire-and-forget: listener errors are their own problem
        Promise.resolve((listener as TaskTerminalListener)(event)).catch((err) =>
          console.error('[task-event] listener error:', err)
        );
      } catch (err) {
        console.error('[task-event] listener threw:', err);
      }
    }
  }
}

function readFileSyncCompat(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
