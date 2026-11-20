import type Database from 'better-sqlite3';

/**
 * MCP injection for a review task (openspec mcp-integration spec).
 *
 * Effective servers = enabled global scope + enabled servers bound to the
 * task's repo. ocr consumes them via its config.json `mcp_servers` section
 * (config-inject capability). ocr cannot filter tools server-side, so a
 * non-empty allowlist is recorded as NOT enforced (`allowlist_enforced = 0`)
 * — the platform does not invent a private filtering protocol (design D5).
 *
 * Every injection is persisted to task_mcp_injection (server_name snapshot
 * survives registry deletion) — the auditable record for the task detail.
 */

export interface EffectiveMcpServer {
  id: number;
  name: string;
  transport: 'stdio' | 'http';
  config: Record<string, unknown>;
  toolAllowlist: string[] | null;
}

/** Collect the servers that apply to a repo (enabled only). */
export function collectEffectiveServers(
  db: Database.Database,
  repoId: number
): EffectiveMcpServer[] {
  const rows = db
    .prepare(
      `SELECT * FROM mcp_server
       WHERE enabled = 1 AND (scope = 'global' OR (scope = 'repo' AND repo_id = ?))
       ORDER BY id`
    )
    .all(repoId) as Record<string, unknown>[];
  return rows.map((r) => {
    const row = r as {
      id: number;
      name: string;
      transport: 'stdio' | 'http';
      config: string;
      tool_allowlist: string | null;
    };
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(row.config) as Record<string, unknown>;
    } catch {
      config = {};
    }
    let allowlist: string[] | null = null;
    if (row.tool_allowlist) {
      try {
        allowlist = JSON.parse(row.tool_allowlist) as string[];
      } catch {
        allowlist = null;
      }
    }
    return {
      id: row.id,
      name: row.name,
      transport: row.transport,
      config,
      toolAllowlist: allowlist,
    };
  });
}

/**
 * Build the ocr config.json `mcp_servers` section (ocr >= 1.13 format:
 * mcp_servers.<name>.<command|args|env|url|headers|enabled|type>).
 * Empty map when there is nothing to inject — the caller then writes the
 * provider-only config.
 */
export function buildOcrMcpServers(servers: EffectiveMcpServer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.transport === 'stdio') {
      out[s.name] = {
        command: s.config.command,
        args: s.config.args ?? [],
        env: s.config.env ?? {},
        enabled: true,
      };
    } else {
      out[s.name] = {
        url: s.config.url,
        headers: s.config.headers ?? {},
        enabled: true,
        type: 'http',
      };
    }
  }
  return out;
}

/** Persist the injection record for a task (call after task row exists). */
export function recordMcpInjection(
  db: Database.Database,
  taskId: number,
  servers: EffectiveMcpServer[]
): void {
  if (servers.length === 0) return;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO task_mcp_injection
       (task_id, server_id, server_name, allowlist_enforced, tool_stats)
     VALUES (?, ?, ?, ?, NULL)`
  );
  const tx = db.transaction(() => {
    for (const s of servers) {
      // ocr's config-inject cannot filter tools per-call: a non-empty
      // allowlist stays visible in the audit as NOT enforced.
      insert.run(taskId, s.id, s.name, s.toolAllowlist && s.toolAllowlist.length > 0 ? 0 : 1);
    }
  });
  tx();
}

/** Store engine-reported tool stats on the injection rows (JSON). */
export function recordMcpToolStats(
  db: Database.Database,
  taskId: number,
  stats: Record<string, { calls: number; failures: number }>
): void {
  if (!stats || Object.keys(stats).length === 0) return;
  db.prepare(
    `UPDATE task_mcp_injection SET tool_stats = ? WHERE task_id = ?`
  ).run(JSON.stringify(stats), taskId);
}

/** Injection audit rows for the task detail API. */
export function injectionAuditForTask(
  db: Database.Database,
  taskId: number
): {
  servers: { serverId: number; serverName: string; allowlistEnforced: boolean; toolStats: unknown }[];
  statsReported: boolean;
} {
  const rows = db
    .prepare('SELECT * FROM task_mcp_injection WHERE task_id = ? ORDER BY server_id')
    .all(taskId) as Record<string, unknown>[];
  const servers = rows.map((r) => ({
    serverId: r.server_id as number,
    serverName: r.server_name as string,
    allowlistEnforced: r.allowlist_enforced === 1,
    toolStats: r.tool_stats ? JSON.parse(r.tool_stats as string) : null,
  }));
  return {
    servers,
    statsReported: servers.some((s) => s.toolStats !== null),
  };
}
