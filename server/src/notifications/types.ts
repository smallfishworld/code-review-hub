/**
 * Notification subsystem shared types.
 *
 * A channel is a stored configuration (email SMTP or chat webhook). The
 * sender (task 6.4) resolves enabled channels, renders the message with the
 * task context and hands it to a channel adapter (tasks 6.2 / 6.3).
 */

export type ChannelType = 'email' | 'chat';

/** Global trigger rule — applies uniformly to all channels. */
export type NotificationTrigger = 'all' | 'failed_only' | 'success_only';

export const NOTIFICATION_TRIGGERS: NotificationTrigger[] = [
  'all',
  'failed_only',
  'success_only',
];

/** Non-secret channel configuration, stored as JSON in notification_channel.config. */
export interface EmailChannelConfig {
  host: string;
  port: number;
  secure?: boolean;
  from: string;
  to: string[];
  username?: string;
}

export interface ChatChannelConfig {
  webhookUrl: string;
  /** Extra request headers (e.g. platform auth headers). Values may be secrets. */
  headers?: Record<string, string>;
}

export type ChannelConfig = EmailChannelConfig | ChatChannelConfig;

/** Values substituted into chat templates. */
export interface NotificationContext {
  repo: string;
  /** Repository URL (SVN path / git URL) as configured. */
  repo_url: string;
  node: string;
  author: string;
  /** Commit log message, snapshot taken at enqueue time. */
  commit_message: string;
  /** Commit date, local time (e.g. 2026-11-27 16:59). */
  commit_date: string;
  status: string;
  summary: string;
  report_url: string;
}

/** A channel adapter turns a context into a concrete delivery. */
export interface ChannelAdapter {
  send(context: NotificationContext): Promise<void>;
}

/** Decide whether a task status should notify under the global trigger rule. */
export function matchesTrigger(
  trigger: NotificationTrigger,
  status: string
): boolean {
  if (trigger === 'all') return true;
  if (trigger === 'failed_only') return status === 'failed';
  return status === 'succeeded';
}

/** Parse a stored trigger value, falling back to 'all' for unknown data. */
export function parseTrigger(value: string | null | undefined): NotificationTrigger {
  return NOTIFICATION_TRIGGERS.includes(value as NotificationTrigger)
    ? (value as NotificationTrigger)
    : 'all';
}
