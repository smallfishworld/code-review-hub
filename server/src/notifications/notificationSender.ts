import type Database from 'better-sqlite3';
import type { TaskRecord } from '../tasks/taskQueue.js';
import type { TaskEventHub } from '../tasks/taskEvents.js';
import type { ReportService } from '../tasks/reportService.js';
import type { ChannelService, ChannelDto } from './channelService.js';
import type { EmailChannel } from './emailChannel.js';
import type { ChatChannel } from './chatChannel.js';
import { matchesTrigger, type NotificationContext } from './types.js';
import { statusLabel, formatCommitDate } from './render.js';

/**
 * Notification sender (task 6.4).
 *
 * Consumes terminal task events, applies the global trigger rule, and sends
 * asynchronously to every enabled channel. Delivery is retried a bounded
 * number of times with backoff; the final outcome is written to
 * `notification_log`. Nothing here can affect the task itself: every error is
 * caught and logged, and the queue is never awaited.
 */

export interface SenderOptions {
  /** Public base URL used to build report links. */
  baseUrl?: string;
  /**
   * Builds the share URL for a task (creates a share token on demand).
   * When provided, {{report_url}} points at the read-only share page
   * instead of the (login-gated) console task page.
   */
  shareUrlFor?: (taskId: number) => string | null;
  /** Total delivery attempts per channel (default 3). */
  attempts?: number;
  /** Backoff delays between attempts, ms (default 500, 1500). */
  retryDelaysMs?: number[];
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface NotificationLogEntry {
  id: number;
  taskId: number;
  channelId: number;
  channelName: string | null;
  channelType: string | null;
  status: 'sent' | 'failed';
  detail: string | null;
  createdAt: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NotificationSender {
  private readonly attempts: number;
  private readonly retryDelaysMs: number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly shareUrlFor?: (taskId: number) => string | null;

  constructor(
    private readonly db: Database.Database,
    private readonly channels: ChannelService,
    private readonly email: EmailChannel,
    private readonly chat: ChatChannel,
    private readonly reports: ReportService,
    options: SenderOptions = {}
  ) {
    this.attempts = Math.max(1, options.attempts ?? 3);
    this.retryDelaysMs = options.retryDelaysMs ?? [500, 1500];
    this.sleep = options.sleep ?? defaultSleep;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3000').replace(/\/+$/, '');
    this.shareUrlFor = options.shareUrlFor;
  }

  /** Subscribe to terminal events. Returns an unsubscribe function. */
  start(events: TaskEventHub): () => void {
    const listener = (event: { task: TaskRecord }) => {
      // fire-and-forget: never block the queue or the event hub
      void this.notify(event.task).catch((err) => {
        console.error('[notify] unexpected sender failure:', err);
      });
    };
    events.onTerminal(listener);
    return () => events.off('terminal', listener);
  }

  /** Decide + dispatch notifications for one finished task. */
  async notify(task: TaskRecord): Promise<void> {
    if (task.status !== 'succeeded' && task.status !== 'failed') return;
    if (!matchesTrigger(this.channels.getTrigger(), task.status)) return;

    const channels = this.channels.enabledChannels();
    if (channels.length === 0) return;

    const context = this.buildContext(task);
    await Promise.all(channels.map((channel) => this.deliver(channel, context, task.id)));
  }

  /** Build the template context for a task. */
  buildContext(task: TaskRecord): NotificationContext {
    const repo = this.db.prepare('SELECT name, url FROM repo WHERE id = ?').get(task.repoId) as
      | { name: string; url: string }
      | undefined;
    let summary: string;
    if (task.status === 'succeeded') {
      const report = this.reports.get(task.id);
      summary = report?.summary ?? '评审完成（无报告摘要）';
    } else {
      summary = task.error ? `评审失败：${task.error}` : '评审失败';
    }
    return {
      repo: repo?.name ?? `repo#${task.repoId}`,
      repo_url: repo?.url ?? '',
      node: task.node,
      author: task.author ?? '未知',
      commit_message: task.commitMessage ?? '',
      commit_date: task.commitDate ? formatCommitDate(task.commitDate) : '',
      status: statusLabel(task.status),
      summary,
      // Prefer the share link: recipients get a read-only report page that
      // needs no login. Fallback = console URL (e.g. share table missing).
      report_url:
        this.shareUrlFor?.(task.id) ?? `${this.baseUrl}/tasks/${task.id}`,
    };
  }

  /** Send to one channel with bounded retries; always records a log row. */
  private async deliver(
    channel: ChannelDto,
    context: NotificationContext,
    taskId: number
  ): Promise<void> {
    let lastError = '';
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        if (channel.type === 'email') await this.email.send(channel.id, context);
        else await this.chat.send(channel.id, context);
        this.log(taskId, channel.id, 'sent', null);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < this.attempts) {
          const delay = this.retryDelaysMs[attempt - 1] ?? 0;
          if (delay > 0) await this.sleep(delay);
        }
      }
    }
    this.log(taskId, channel.id, 'failed', `重试 ${this.attempts} 次后失败：${lastError}`);
  }

  private log(
    taskId: number,
    channelId: number,
    status: 'sent' | 'failed',
    detail: string | null
  ): void {
    try {
      this.db
        .prepare(
          'INSERT INTO notification_log (task_id, channel_id, status, detail) VALUES (?, ?, ?, ?)'
        )
        .run(taskId, channelId, status, detail);
    } catch (err) {
      console.error('[notify] failed to write notification log:', err);
    }
  }

  /** Notification log, newest first, optionally filtered by task. */
  logs(options: { taskId?: number; limit?: number } = {}): NotificationLogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = (
      options.taskId
        ? this.db
            .prepare(
              `SELECT l.*, c.name AS channel_name, c.type AS channel_type
               FROM notification_log l LEFT JOIN notification_channel c ON c.id = l.channel_id
               WHERE l.task_id = ? ORDER BY l.id DESC LIMIT ?`
            )
            .all(options.taskId, limit)
        : this.db
            .prepare(
              `SELECT l.*, c.name AS channel_name, c.type AS channel_type
               FROM notification_log l LEFT JOIN notification_channel c ON c.id = l.channel_id
               ORDER BY l.id DESC LIMIT ?`
            )
            .all(limit)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      taskId: r.task_id as number,
      channelId: r.channel_id as number,
      channelName: (r.channel_name as string | null) ?? null,
      channelType: (r.channel_type as string | null) ?? null,
      status: r.status as 'sent' | 'failed',
      detail: (r.detail as string | null) ?? null,
      createdAt: r.created_at as string,
    }));
  }
}
