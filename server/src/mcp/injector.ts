import type Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_MEMORY_QUERY } from '../memory/mcpBridge.js';

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
 * Build the ocr config.json `mcp_servers` section. Verified against the real
 * ocr 1.13.8-svn.1 Go struct: `mcp_servers.<name>.env` is []string (each entry
 * "KEY=VALUE") — NOT an object; args is a plain string array.
 * Empty map when there is nothing to inject — the caller then writes the
 * provider-only config.
 *
 * `ctx` (dataDir + repoId) is required so the builtin memory.query server can
 * be handed its per-task scope via env — the tool parameters never carry a
 * repo identifier (project-memory spec: 记忆查询 MCP 桥).
 */
export function buildOcrMcpServers(
  servers: EffectiveMcpServer[],
  ctx?: { dataDir: string; repoId: number }
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    if (s.transport === 'stdio') {
      const env = (s.config.env ?? {}) as Record<string, unknown>;
      const envEntries = Object.entries(env).map(([k, v]) => `${k}=${String(v)}`);
      if (ctx && s.name === BUILTIN_MEMORY_QUERY) {
        envEntries.push(`CRP_DATA_DIR=${ctx.dataDir}`, `CRP_REPO_ID=${String(ctx.repoId)}`);
      }
      out[s.name] = {
        command: s.config.command,
        args: s.config.args ?? [],
        env: envEntries,
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

/** Absolute path of the compiled bridge script (sibling of this module). */
export function bridgeScriptPath(importerUrl = import.meta.url): string {
  const here = dirname(fileURLToPath(importerUrl));
  return resolve(here, '../memory-mcp-bridge.js');
}

/**
 * Ensure the builtin memory.query MCP server row exists (project-memory spec:
 * 记忆查询 MCP 桥 / mcp-integration spec: 内置记忆查询桥的自动附加). The row is
 * system-owned: config (command/args) is refreshed to the current build on
 * every platform start; the only user-controllable field is `enabled`
 * (flipping it off disables auto-attach). Called once at platform startup.
 */
export function ensureBuiltinMemoryQuery(db: Database.Database): void {
  const config = JSON.stringify({
    command: 'node',
    args: [bridgeScriptPath()],
    env: {},
  });
  const existing = db
    .prepare('SELECT id, config FROM mcp_server WHERE name = ?')
    .get(BUILTIN_MEMORY_QUERY) as { id: number; config: string } | undefined;
  if (!existing) {
    db.prepare(
      `INSERT INTO mcp_server (name, transport, config, enabled, scope, timeout_sec)
       VALUES (?, 'stdio', ?, 1, 'global', 15)`
    ).run(BUILTIN_MEMORY_QUERY, config);
    return;
  }
  // Track dist moves / version bumps: keep the system row's command current.
  db.prepare('UPDATE mcp_server SET config = ? WHERE id = ?').run(config, existing.id);
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
