import type Database from 'better-sqlite3';
import type { TaskQueue, TaskCompletedEvent } from './taskQueue.js';
import { ReportService } from './reportService.js';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * Task-completion hook: indexes the ocr report of each finished task and
 * fans the terminal-state event out to subscribers (notification subsystem).
 *
 * All listeners run asynchronously and failures are isolated — a broken
 * listener must never affect task status or other listeners.
 */

export type TaskTerminalListener = (event: TaskCompletedEvent) => void;

export class TaskEventHub extends EventEmitter {
  constructor(
    private readonly db: Database.Database,
    private readonly queue: TaskQueue,
    private readonly reports: ReportService,
    private readonly dataDir: string
  ) {
    super();
  }

  /** Attach to the queue; call once at startup. */
  start(): void {
    this.queue.on('completed', (event: TaskCompletedEvent) => {
      // 1. index the report (succeeded tasks have a raw JSON file)
      this.indexReport(event);
      // 2. fan out to subscribers (notifications etc.)
      this.notifyListeners(event);
    });
  }

  /** Register a terminal-state listener (e.g. notification sender). */
  onTerminal(listener: TaskTerminalListener): void {
    this.on('terminal', listener);
  }

  private indexReport(event: TaskCompletedEvent): void {
    if (event.task.status !== 'succeeded') return;
    try {
      const rawPath = join(this.dataDir, 'reports', `${event.task.id}.json`);
      this.reports.indexTaskReport(event.task.id, rawPath);
    } catch (err) {
      // report indexing must never break the queue
      console.error(`[report-index] task ${event.task.id} failed:`, err);
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
