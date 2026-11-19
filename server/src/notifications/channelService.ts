import type Database from 'better-sqlite3';
import type { CredentialService } from '../crypto/credentialService.js';
import {
  NOTIFICATION_TRIGGERS,
  parseTrigger,
  type ChannelType,
  type EmailChannelConfig,
  type NotificationTrigger,
} from './types.js';

/**
 * Notification channel configuration (task 6.1).
 *
 * Two channel types share one table:
 *  - email: SMTP settings in `config` (host/port/from/to/username), password
 *    in an encrypted credential row.
 *  - chat:  the webhook URL and any auth headers are themselves secrets
 *    (platform tokens usually live in the URL path), so the whole bundle is
 *    stored in one encrypted credential row. `config` keeps only the display
 *    host and the header names.
 *
 * Responses never contain plaintext secrets: URLs are reduced to their origin
 * and every secret value is replaced with `********`.
 */

export class ChannelError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export interface ChannelInput {
  type?: ChannelType;
  name?: string;
  enabled?: boolean;
  template?: string | null;
  // email
  host?: string;
  port?: number;
  secure?: boolean;
  from?: string;
  to?: string[];
  username?: string;
  password?: string;
  // chat
  webhookUrl?: string;
  headers?: Record<string, string>;
}

export interface ChannelDto {
  id: number;
  type: ChannelType;
  name: string;
  enabled: boolean;
  template: string | null;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ChannelRow {
  id: number;
  type: ChannelType;
  name: string;
  enabled: number;
  config: string;
  credential_id: number | null;
  template: string | null;
  created_at: string;
  updated_at: string;
}

/** Secret bundle stored for chat channels. */
export interface ChatSecret {
  webhookUrl: string;
  headers: Record<string, string>;
}

export const MASK = '********';

/** Reduce a URL to its origin so tokens in path/query never leak. */
export function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${MASK}`;
  } catch {
    return MASK;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export class ChannelService {
  constructor(
    private readonly db: Database.Database,
    private readonly credentials: CredentialService
  ) {}

  private row(id: number): ChannelRow | undefined {
    return this.db
      .prepare('SELECT * FROM notification_channel WHERE id = ?')
      .get(id) as ChannelRow | undefined;
  }

  private parseConfig(row: ChannelRow): Record<string, unknown> {
    try {
      const parsed = JSON.parse(row.config) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** Masked DTO — safe to return from the API. */
  toDto(row: ChannelRow): ChannelDto {
    const stored = this.parseConfig(row);
    let config: Record<string, unknown>;
    if (row.type === 'email') {
      config = {
        host: stored.host ?? '',
        port: stored.port ?? 587,
        secure: stored.secure === true,
        from: stored.from ?? '',
        to: Array.isArray(stored.to) ? stored.to : [],
        username: stored.username ?? '',
        hasPassword: row.credential_id !== null,
        password: row.credential_id !== null ? MASK : '',
      };
    } else {
      const headerNames = Array.isArray(stored.headerNames)
        ? (stored.headerNames as string[])
        : [];
      const headers: Record<string, string> = {};
      for (const name of headerNames) headers[name] = MASK;
      config = {
        webhookUrl: row.credential_id !== null ? maskUrl(String(stored.webhookHost ?? '')) : '',
        webhookHost: stored.webhookHost ?? '',
        headers,
        hasCredential: row.credential_id !== null,
      };
    }
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled === 1,
      template: row.template,
      config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): ChannelDto[] {
    const rows = this.db
      .prepare('SELECT * FROM notification_channel ORDER BY id')
      .all() as ChannelRow[];
    return rows.map((r) => this.toDto(r));
  }

  get(id: number): ChannelDto {
    const row = this.row(id);
    if (!row) throw new ChannelError('通知渠道不存在', 404);
    return this.toDto(row);
  }

  /** Full (unmasked) email SMTP config + password, for the sender. */
  emailConfig(id: number): { config: EmailChannelConfig; password: string | null } {
    const row = this.row(id);
    if (!row) throw new ChannelError('通知渠道不存在', 404);
    if (row.type !== 'email') throw new ChannelError('该渠道不是邮件渠道', 400);
    const stored = this.parseConfig(row);
    return {
      config: {
        host: String(stored.host ?? ''),
        port: Number(stored.port ?? 587),
        secure: stored.secure === true,
        from: String(stored.from ?? ''),
        to: Array.isArray(stored.to) ? (stored.to as string[]) : [],
        username: stored.username ? String(stored.username) : undefined,
      },
      password: row.credential_id ? this.credentials.reveal(row.credential_id) : null,
    };
  }

  /** Full (unmasked) chat webhook bundle, for the sender. */
  chatConfig(id: number): ChatSecret {
    const row = this.row(id);
    if (!row) throw new ChannelError('通知渠道不存在', 404);
    if (row.type !== 'chat') throw new ChannelError('该渠道不是聊天机器人渠道', 400);
    if (!row.credential_id) throw new ChannelError('该渠道未配置 webhook 地址', 400);
    const raw = this.credentials.reveal(row.credential_id);
    if (!raw) throw new ChannelError('该渠道未配置 webhook 地址', 400);
    try {
      const parsed = JSON.parse(raw) as Partial<ChatSecret>;
      return {
        webhookUrl: String(parsed.webhookUrl ?? ''),
        headers:
          parsed.headers && typeof parsed.headers === 'object' ? parsed.headers : {},
      };
    } catch {
      // legacy/plain storage: the credential is the URL itself
      return { webhookUrl: raw, headers: {} };
    }
  }

  enabledChannels(): ChannelDto[] {
    const rows = this.db
      .prepare('SELECT * FROM notification_channel WHERE enabled = 1 ORDER BY id')
      .all() as ChannelRow[];
    return rows.map((r) => this.toDto(r));
  }

  create(input: ChannelInput): ChannelDto {
    const type = this.validateType(input.type);
    const name = this.validateName(input.name);
    if (this.db.prepare('SELECT id FROM notification_channel WHERE name = ?').get(name)) {
      throw new ChannelError(`通知渠道名称 "${name}" 已存在`, 409);
    }
    const { configJson, credentialId } = this.buildStorage(type, name, input, null);

    const info = this.db
      .prepare(
        `INSERT INTO notification_channel (type, name, enabled, config, credential_id, template)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        type,
        name,
        input.enabled ? 1 : 0,
        JSON.stringify(configJson),
        credentialId,
        input.template ?? null
      );
    return this.get(Number(info.lastInsertRowid));
  }

  update(id: number, input: ChannelInput): ChannelDto {
    const row = this.row(id);
    if (!row) throw new ChannelError('通知渠道不存在', 404);
    const name = input.name !== undefined ? this.validateName(input.name) : row.name;
    if (name !== row.name) {
      const dup = this.db
        .prepare('SELECT id FROM notification_channel WHERE name = ? AND id != ?')
        .get(name, id);
      if (dup) throw new ChannelError(`通知渠道名称 "${name}" 已存在`, 409);
    }
    if (input.type !== undefined && input.type !== row.type) {
      throw new ChannelError('渠道类型不可修改，请新建渠道', 400);
    }

    const { configJson, credentialId } = this.buildStorage(
      row.type,
      name,
      input,
      row
    );

    this.db
      .prepare(
        `UPDATE notification_channel
         SET name = ?, enabled = ?, config = ?, credential_id = ?, template = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(
        name,
        input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
        JSON.stringify(configJson),
        credentialId,
        input.template === undefined ? row.template : input.template,
        id
      );
    return this.get(id);
  }

  setEnabled(id: number, enabled: boolean): ChannelDto {
    const row = this.row(id);
    if (!row) throw new ChannelError('通知渠道不存在', 404);
    this.db
      .prepare(
        `UPDATE notification_channel
         SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .run(enabled ? 1 : 0, id);
    return this.get(id);
  }

  delete(id: number): void {
    const row = this.row(id);
    if (!row) throw new ChannelError('通知渠道不存在', 404);
    this.db.prepare('DELETE FROM notification_channel WHERE id = ?').run(id);
    if (row.credential_id) this.credentials.delete(row.credential_id);
  }

  // --- global trigger rule -------------------------------------------------

  getTrigger(): NotificationTrigger {
    const row = this.db
      .prepare("SELECT value FROM setting WHERE key = 'notification_trigger'")
      .get() as { value: string } | undefined;
    return parseTrigger(row?.value);
  }

  setTrigger(trigger: string): NotificationTrigger {
    if (!NOTIFICATION_TRIGGERS.includes(trigger as NotificationTrigger)) {
      throw new ChannelError(
        `触发规则必须是 ${NOTIFICATION_TRIGGERS.join(' / ')} 之一`
      );
    }
    this.db
      .prepare(
        `INSERT INTO setting (key, value) VALUES ('notification_trigger', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(trigger);
    return trigger as NotificationTrigger;
  }

  // --- validation / storage ------------------------------------------------

  private validateType(type: unknown): ChannelType {
    if (type !== 'email' && type !== 'chat') {
      throw new ChannelError('渠道类型必须是 email 或 chat');
    }
    return type;
  }

  private validateName(name: unknown): string {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ChannelError('渠道名称不能为空');
    }
    return name.trim();
  }

  private buildStorage(
    type: ChannelType,
    name: string,
    input: ChannelInput,
    existing: ChannelRow | null
  ): { configJson: Record<string, unknown>; credentialId: number | null } {
    return type === 'email'
      ? this.buildEmailStorage(name, input, existing)
      : this.buildChatStorage(name, input, existing);
  }

  private buildEmailStorage(
    name: string,
    input: ChannelInput,
    existing: ChannelRow | null
  ): { configJson: Record<string, unknown>; credentialId: number | null } {
    const prev = existing ? this.parseConfig(existing) : {};
    const host = input.host !== undefined ? String(input.host).trim() : String(prev.host ?? '');
    if (!host) throw new ChannelError('SMTP 服务器地址不能为空');

    const port = input.port !== undefined ? Number(input.port) : Number(prev.port ?? 587);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ChannelError('SMTP 端口必须是 1-65535 的整数');
    }

    const from = input.from !== undefined ? String(input.from).trim() : String(prev.from ?? '');
    if (!from) throw new ChannelError('发件人地址不能为空');

    const to = input.to !== undefined ? input.to : (prev.to as string[] | undefined) ?? [];
    if (!Array.isArray(to) || to.length === 0) {
      throw new ChannelError('收件人列表不能为空');
    }
    for (const addr of to) {
      if (typeof addr !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr.trim())) {
        throw new ChannelError(`收件人地址不合法: ${String(addr)}`);
      }
    }

    const username =
      input.username !== undefined ? String(input.username).trim() : String(prev.username ?? '');
    const secure = input.secure !== undefined ? input.secure === true : prev.secure === true;

    let credentialId = existing?.credential_id ?? null;
    if (input.password !== undefined && input.password !== '') {
      if (credentialId) this.credentials.update(credentialId, input.password);
      else credentialId = this.credentials.store(`channel:${name}`, 'smtp', input.password);
    }

    return {
      configJson: {
        host,
        port,
        secure,
        from,
        to: to.map((a) => a.trim()),
        username,
      },
      credentialId,
    };
  }

  private buildChatStorage(
    name: string,
    input: ChannelInput,
    existing: ChannelRow | null
  ): { configJson: Record<string, unknown>; credentialId: number | null } {
    const prev = existing ? this.parseConfig(existing) : {};
    let secret: ChatSecret | null = null;
    if (existing?.credential_id) {
      try {
        secret = this.chatConfig(existing.id);
      } catch {
        secret = null;
      }
    }

    if (input.webhookUrl !== undefined && input.webhookUrl !== '') {
      if (!isHttpUrl(input.webhookUrl)) {
        throw new ChannelError('webhook 地址必须是合法的 http(s) URL');
      }
      secret = { webhookUrl: input.webhookUrl.trim(), headers: secret?.headers ?? {} };
    }
    if (!secret) throw new ChannelError('webhook 地址不能为空');

    if (input.headers !== undefined) {
      if (typeof input.headers !== 'object' || Array.isArray(input.headers)) {
        throw new ChannelError('自定义 header 必须是键值对象');
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(input.headers)) {
        if (typeof v !== 'string') throw new ChannelError(`header ${k} 的值必须是字符串`);
        // The console only ever sees masked values. Echoing the mask back
        // means "leave this header alone" — storing it literally would
        // replace a real token with `********`.
        if (v === MASK) {
          const kept = secret.headers[k];
          if (kept !== undefined) headers[k] = kept;
          continue;
        }
        if (v.trim() !== '') headers[k] = v;
      }
      secret = { webhookUrl: secret.webhookUrl, headers };
    }

    const payload = JSON.stringify(secret);
    let credentialId = existing?.credential_id ?? null;
    if (credentialId) this.credentials.update(credentialId, payload);
    else credentialId = this.credentials.store(`channel:${name}`, 'chat', payload);

    let webhookHost: string;
    try {
      webhookHost = new URL(secret.webhookUrl).origin;
    } catch {
      webhookHost = '';
    }

    return {
      configJson: {
        webhookHost,
        headerNames: Object.keys(secret.headers),
        // keep the legacy display field in sync for older clients
        webhookUrl: prev.webhookUrl ?? '',
      },
      credentialId,
    };
  }
}
