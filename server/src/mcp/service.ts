import type Database from 'better-sqlite3';

/**
 * MCP server registry service (openspec mcp-integration spec).
 *
 * config shapes:
 * - stdio: { command: string, args?: string[], env?: Record<string,string> }
 * - http:  { url: string, headers?: Record<string,string> }
 *
 * Values may carry credentials (Authorization headers, env tokens). Read
 * paths return a MASKED config (keys preserved, values starred); the full
 * config is only used for injection and connectivity tests.
 */

export interface McpServerRow {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  config: string;
  enabled: number;
  scope: 'global' | 'repo';
  repo_id: number | null;
  tool_allowlist: string | null;
  timeout_sec: number;
  created_at: string;
  updated_at: string;
}

export interface McpServerDto {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  /** Masked config: credential values replaced with ********. */
  config: Record<string, unknown>;
  enabled: boolean;
  scope: 'global' | 'repo';
  repoId: number | null;
  toolAllowlist: string[] | null;
  timeoutSec: number;
  createdAt: string;
  updatedAt: string;
}

export class McpConfigError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

function rowToDto(row: McpServerRow, mask: boolean): McpServerDto {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.config) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    config: mask ? maskConfig(parsed) : parsed,
    enabled: row.enabled === 1,
    scope: row.scope,
    repoId: row.repo_id,
    toolAllowlist: row.tool_allowlist ? (JSON.parse(row.tool_allowlist) as string[]) : null,
    timeoutSec: row.timeout_sec,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Mask credential-bearing values (headers / env), preserving keys. */
export function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  const SECRET_HINT = /(auth|token|key|secret|password|cookie)/i;
  for (const field of ['headers', 'env'] as const) {
    const obj = out[field];
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const masked: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        masked[k] = typeof v === 'string' && v ? (SECRET_HINT.test(k) ? '********' : v) : (v as string);
      }
      out[field] = masked;
    }
  }
  return out;
}

/** Validate a transport-appropriate config; returns the normalized JSON. */
export function validateMcpConfig(
  transport: string,
  config: unknown
): { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new McpConfigError('连接配置必须是 JSON 对象');
  }
  const c = config as Record<string, unknown>;
  if (transport === 'stdio') {
    if (typeof c.command !== 'string' || c.command.trim() === '') {
      throw new McpConfigError('stdio 类型必须提供 command');
    }
    let args: string[] | undefined;
    if (c.args !== undefined) {
      if (!Array.isArray(c.args) || c.args.some((a) => typeof a !== 'string')) {
        throw new McpConfigError('args 必须是字符串数组');
      }
      args = c.args as string[];
    }
    let env: Record<string, string> | undefined;
    if (c.env !== undefined) {
      env = stringRecord(c.env, 'env');
    }
    return { command: c.command.trim(), args, env };
  }
  if (transport === 'http') {
    if (typeof c.url !== 'string' || c.url.trim() === '') {
      throw new McpConfigError('http 类型必须提供 url');
    }
    try {
      const u = new URL(c.url.trim());
      if (!/^https?:$/.test(u.protocol)) throw new Error();
    } catch {
      throw new McpConfigError('url 必须是合法的 http(s) 地址');
    }
    let headers: Record<string, string> | undefined;
    if (c.headers !== undefined) {
      headers = stringRecord(c.headers, 'headers');
    }
    return { url: c.url.trim(), headers };
  }
  throw new McpConfigError('transport 必须是 stdio 或 http');
}

function stringRecord(v: unknown, what: string): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new McpConfigError(`${what} 必须是字符串键值对象`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') throw new McpConfigError(`${what}.${k} 必须是字符串`);
    out[k] = val;
  }
  return out;
}

export function listMcpServers(db: Database.Database, repoId?: number): McpServerDto[] {
  const rows = (
    repoId !== undefined
      ? db
          .prepare(
            "SELECT * FROM mcp_server WHERE enabled = 1 AND (scope = 'global' OR (scope = 'repo' AND repo_id = ?))"
          )
          .all(repoId)
      : db.prepare('SELECT * FROM mcp_server ORDER BY id').all()
  ) as Record<string, unknown>[];
  return rows.map((r) => rowToDto(r as unknown as McpServerRow, true));
}

export function getMcpServer(db: Database.Database, id: number): McpServerDto | null {
  const row = db.prepare('SELECT * FROM mcp_server WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDto(row as unknown as McpServerRow, true) : null;
}

/** Full (unmasked) config for injection / connectivity tests. */
export function getMcpServerFullConfig(db: Database.Database, id: number): Record<string, unknown> {
  const row = db.prepare('SELECT config FROM mcp_server WHERE id = ?').get(id) as
    | { config: string }
    | undefined;
  if (!row) throw new McpConfigError('MCP 服务器不存在', 404);
  return JSON.parse(row.config) as Record<string, unknown>;
}

export interface McpServerInput {
  name?: string;
  transport?: string;
  config?: unknown;
  enabled?: boolean;
  scope?: string;
  repoId?: number | null;
  toolAllowlist?: string[] | null;
  timeoutSec?: number;
}

export function createMcpServer(db: Database.Database, input: McpServerInput): McpServerDto {
  const name = requireName(input);
  const transport = requireTransport(input);
  const normalized = validateMcpConfig(transport, input.config);
  const scope = requireScope(input, db);

  if (input.toolAllowlist !== null && input.toolAllowlist !== undefined) {
    if (
      !Array.isArray(input.toolAllowlist) ||
      input.toolAllowlist.some((t) => typeof t !== 'string' || !t.trim())
    ) {
      throw new McpConfigError('toolAllowlist 必须是非空字符串数组或 null');
    }
  }
  const timeoutSec = input.timeoutSec ?? 10;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) {
    throw new McpConfigError('timeoutSec 必须是 1-600 的整数');
  }

  const dup = db.prepare('SELECT id FROM mcp_server WHERE name = ?').get(name);
  if (dup) throw new McpConfigError(`名称 ${name} 已存在`, 409);

  const info = db
    .prepare(
      `INSERT INTO mcp_server (name, transport, config, enabled, scope, repo_id, tool_allowlist, timeout_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      transport,
      JSON.stringify(normalized),
      input.enabled === false ? 0 : 1,
      scope,
      scope === 'repo' ? (input.repoId as number) : null,
      input.toolAllowlist ? JSON.stringify(input.toolAllowlist) : null,
      timeoutSec
    );
  return getMcpServer(db, Number(info.lastInsertRowid))!;
}

export function updateMcpServer(
  db: Database.Database,
  id: number,
  input: McpServerInput
): McpServerDto {
  const row = db.prepare('SELECT * FROM mcp_server WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new McpConfigError('MCP 服务器不存在', 404);
  const current = row as unknown as McpServerRow;

  const name = input.name?.trim() ?? current.name;
  const transport = input.transport ?? current.transport;
  if (!['stdio', 'http'].includes(transport)) throw new McpConfigError('transport 必须是 stdio 或 http');
  const normalized = validateMcpConfig(
    transport,
    input.config !== undefined ? input.config : JSON.parse(current.config)
  );
  const scope = input.scope ?? current.scope;
  if (!['global', 'repo'].includes(scope)) throw new McpConfigError('scope 必须是 global 或 repo');
  const repoId =
    scope === 'repo' ? (input.repoId ?? current.repo_id) : null;
  if (scope === 'repo' && !repoId) throw new McpConfigError('repo 作用域必须绑定仓库');
  if (repoId !== null) {
    const repo = db.prepare('SELECT id FROM repo WHERE id = ?').get(repoId);
    if (!repo) throw new McpConfigError('绑定的仓库不存在');
  }
  if (name !== current.name) {
    const dup = db.prepare('SELECT id FROM mcp_server WHERE name = ?').get(name);
    if (dup) throw new McpConfigError(`名称 ${name} 已存在`, 409);
  }
  const timeoutSec = input.timeoutSec ?? current.timeout_sec;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) {
    throw new McpConfigError('timeoutSec 必须是 1-600 的整数');
  }

  db.prepare(
    `UPDATE mcp_server SET name = ?, transport = ?, config = ?, enabled = ?, scope = ?,
       repo_id = ?, tool_allowlist = ?, timeout_sec = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    name,
    transport,
    JSON.stringify(normalized),
    input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
    scope,
    repoId,
    input.toolAllowlist === undefined
      ? current.tool_allowlist
      : input.toolAllowlist
        ? JSON.stringify(input.toolAllowlist)
        : null,
    timeoutSec,
    id
  );
  return getMcpServer(db, id)!;
}

export function deleteMcpServer(db: Database.Database, id: number): void {
  const row = db.prepare('SELECT id FROM mcp_server WHERE id = ?').get(id);
  if (!row) throw new McpConfigError('MCP 服务器不存在', 404);
  db.prepare('DELETE FROM mcp_server WHERE id = ?').run(id);
}

function requireName(input: McpServerInput): string {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new McpConfigError('名称不能为空');
  }
  return input.name.trim();
}

function requireTransport(input: McpServerInput): 'stdio' | 'http' {
  if (input.transport !== 'stdio' && input.transport !== 'http') {
    throw new McpConfigError('transport 必须是 stdio 或 http');
  }
  return input.transport;
}

function requireScope(input: McpServerInput, db: Database.Database): 'global' | 'repo' {
  const scope = input.scope ?? 'global';
  if (scope !== 'global' && scope !== 'repo') {
    throw new McpConfigError('scope 必须是 global 或 repo');
  }
  if (scope === 'repo') {
    if (!input.repoId) throw new McpConfigError('repo 作用域必须绑定仓库');
    const repo = db.prepare('SELECT id FROM repo WHERE id = ?').get(input.repoId);
    if (!repo) throw new McpConfigError('绑定的仓库不存在');
  }
  return scope;
}
