import type { ChannelService } from './channelService.js';
import { statusLabel, formatCommitDate } from './render.js';
import type { NotificationContext } from './types.js';

/**
 * Chat-bot channel (task 6.3): generic webhook POST.
 *
 * Template modes:
 *  - whole-JSON template: parse the template, then render placeholders in
 *    JSON string values. The result becomes the structured request body
 *    (markdown blocks, cards, ...).
 *  - plain-text template: rendered text is wrapped in the default envelope
 *    `{"text": "<rendered>"}`.
 *  - no template: built-in default text template.
 *
 * Placeholders: {{repo}} {{node}} {{author}} {{status}} {{summary}} {{report_url}}.
 * Unknown placeholders are left untouched so template typos stay visible.
 */

export const PLACEHOLDERS = [
  'repo',
  'repo_url',
  'node',
  'author',
  'commit_message',
  'commit_date',
  'status',
  'summary',
  'report_url',
] as const;

export const DEFAULT_TEMPLATE = [
  '【代码评审】{{repo}} {{node}} {{status}}',
  '上库人员：{{author}}',
  '摘要：{{summary}}',
  '报告：{{report_url}}',
].join('\n');

/** Substitute {{key}} placeholders; unknown keys are preserved. */
export function renderTemplate(template: string, context: NotificationContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    if ((PLACEHOLDERS as readonly string[]).includes(key)) {
      return context[key as keyof NotificationContext] ?? '';
    }
    return match;
  });
}

export class TemplateError extends Error {}

/**
 * Render a chat template into the request body.
 * Throws TemplateError when a whole-JSON template does not parse.
 */
export function buildChatPayload(
  template: string | null | undefined,
  context: NotificationContext
): unknown {
  const source = template && template.trim() !== '' ? template : DEFAULT_TEMPLATE;
  const trimmed = source.trim();
  // A leading placeholder in a text template is not a JSON object opener.
  const isJsonObject = trimmed.startsWith('{') && !trimmed.startsWith('{{');
  if (isJsonObject || trimmed.startsWith('[')) {
    try {
      // Render decoded string values, not JSON syntax. post() serializes the
      // result, so repository text can contain quotes, backslashes or newlines.
      return JSON.parse(trimmed, (_key, value: unknown) =>
        typeof value === 'string' ? renderTemplate(value, context) : value
      ) as unknown;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new TemplateError(`JSON 模板不是合法 JSON：${reason}`);
    }
  }
  return { text: renderTemplate(source, context) };
}

/** Build the context used by the test-send endpoint. */
export function sampleContext(): NotificationContext {
  return {
    repo: 'demo-repo',
    repo_url: 'svn://demo/srv/main',
    node: '1234',
    author: 'test-user',
    commit_message: '示例提交：修复登录超时问题',
    commit_date: formatCommitDate(new Date().toISOString()),
    status: statusLabel('succeeded'),
    summary: '这是一条测试通知，收到即表示渠道配置正确。',
    report_url: 'http://localhost:3000/tasks/0',
  };
}

export interface ChatSendResult {
  status: number;
  body: string;
}

export class ChatChannel {
  constructor(
    private readonly channels: ChannelService,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Render the stored template for a channel. */
  render(channelId: number, context: NotificationContext): unknown {
    const channel = this.channels.get(channelId);
    return buildChatPayload(channel.template, context);
  }

  /** POST a review notification to the channel's webhook. */
  async send(channelId: number, context: NotificationContext): Promise<void> {
    await this.post(channelId, this.render(channelId, context));
  }

  /** POST an arbitrary payload (test-send endpoint). */
  async sendRaw(channelId: number, payload: unknown): Promise<void> {
    await this.post(channelId, payload);
  }

  private async post(channelId: number, payload: unknown): Promise<void> {
    const { webhookUrl, headers } = this.channels.chatConfig(channelId);
    if (!webhookUrl) throw new Error('webhook 地址未配置');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`webhook 返回 HTTP ${res.status}${body ? `：${body}` : ''}`);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('webhook 请求超时（15 秒）', { cause: err });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
