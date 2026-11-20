import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import {
  createMcpServer,
  listMcpServers,
  updateMcpServer,
  deleteMcpServer,
  maskConfig,
  getMcpServer,
  McpConfigError,
} from './service.js';
import { collectEffectiveServers, buildOcrMcpServers, ensureBuiltinMemoryQuery, bridgeScriptPath, recordMcpInjection } from './injector.js';
import { BUILTIN_MEMORY_QUERY } from '../memory/mcpBridge.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-mcp-'));
  db = openDatabase({ dataDir: dir });
  db.prepare(
    "INSERT INTO repo (type, name, url) VALUES ('git', 'r1', 'http://example/r1')"
  ).run();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mcp service validation', () => {
  it('creates a stdio server and rejects missing command', () => {
    const created = createMcpServer(db, {
      name: 'codegraph',
      transport: 'stdio',
      config: { command: 'codegraph', args: ['serve', '--mcp'] },
    });
    expect(created.enabled).toBe(true);
    expect(created.scope).toBe('global');
    expect(() =>
      createMcpServer(db, { name: 'bad', transport: 'stdio', config: { args: [] } })
    ).toThrow(McpConfigError);
  });

  it('rejects http without url and non-http url', () => {
    expect(() =>
      createMcpServer(db, { name: 'h1', transport: 'http', config: {} })
    ).toThrow(McpConfigError);
    expect(() =>
      createMcpServer(db, { name: 'h2', transport: 'http', config: { url: 'ftp://x' } })
    ).toThrow(McpConfigError);
  });

  it('enforces the scope/repo consistency constraint at the DB level', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO mcp_server (name, transport, config, scope, repo_id) VALUES ('x','stdio','{}','global',1)"
        )
        .run()
    ).toThrow();
  });

  it('rejects a repo-scoped server without repo and unknown repo binding', () => {
    expect(() =>
      createMcpServer(db, { name: 's1', transport: 'stdio', config: { command: 'a' }, scope: 'repo' })
    ).toThrow(McpConfigError);
    expect(() =>
      createMcpServer(db, {
        name: 's2',
        transport: 'stdio',
        config: { command: 'a' },
        scope: 'repo',
        repoId: 999,
      })
    ).toThrow(McpConfigError);
  });

  it('masks secret-looking headers/env on read paths', () => {
    createMcpServer(db, {
      name: 'http-with-auth',
      transport: 'http',
      config: { url: 'https://mcp.example', headers: { Authorization: 'Bearer sekret', 'X-Trace': 't1' } },
    });
    const dto = getMcpServer(db, 1)!;
    const headers = dto.config.headers as Record<string, string>;
    expect(headers.Authorization).toBe('********');
    expect(headers['X-Trace']).toBe('t1');
  });

  it('collectEffectiveServers returns enabled global + repo servers only', () => {
    createMcpServer(db, { name: 'g1', transport: 'stdio', config: { command: 'a' } });
    createMcpServer(db, {
      name: 'r1',
      transport: 'stdio',
      config: { command: 'b' },
      scope: 'repo',
      repoId: 1,
    });
    createMcpServer(db, {
      name: 'r2',
      transport: 'stdio',
      config: { command: 'c' },
      scope: 'repo',
      repoId: 1,
      enabled: false,
    });
    db.prepare("INSERT INTO repo (type, name, url) VALUES ('git', 'r9', 'http://example/r9')").run();
    createMcpServer(db, {
      name: 'other-repo',
      transport: 'stdio',
      config: { command: 'd' },
      scope: 'repo',
      repoId: 2,
    });
    const effective = collectEffectiveServers(db, 1);
    const names = effective.map((s) => s.name).sort();
    expect(names).toEqual(['g1', 'r1']);
  });

  it('buildOcrMcpServers maps stdio and http shapes (env as KEY=VALUE array per ocr Go struct)', () => {    const mapped = buildOcrMcpServers([
      { id: 1, name: 'cg', transport: 'stdio', config: { command: 'codegraph', args: ['serve'] }, toolAllowlist: null },
      {
        id: 2,
        name: 'remote',
        transport: 'http',
        config: { url: 'https://x', headers: { a: 'b' } },
        toolAllowlist: ['t1'],
      },
      {
        id: 3,
        name: 'with-env',
        transport: 'stdio',
        config: { command: 'mcp', env: { API_KEY: 'k', MODE: 'x' } },
        toolAllowlist: null,
      },
    ]);
    expect(mapped.cg).toMatchObject({ command: 'codegraph', env: [], enabled: true });
    expect(mapped.remote).toMatchObject({ url: 'https://x', type: 'http', enabled: true });
    expect(mapped['with-env'].env).toEqual(['API_KEY=k', 'MODE=x']);
  });

  it('updates and deletes; cascade removes repo-scoped rows with the repo', () => {
    const created = createMcpServer(db, { name: 'u', transport: 'stdio', config: { command: 'a' } });
    updateMcpServer(db, created.id, { enabled: false, toolAllowlist: ['only-this'] });
    expect(getMcpServer(db, created.id)?.enabled).toBe(false);
    expect(getMcpServer(db, created.id)?.toolAllowlist).toEqual(['only-this']);
    deleteMcpServer(db, created.id);
    expect(listMcpServers(db)).toHaveLength(0);
  });

  it('masks through maskConfig for arbitrary shapes', () => {
    const masked = maskConfig({ headers: { 'X-Api-Key': 'k', Accept: 'json' }, command: 'run' });
    expect((masked.headers as Record<string, string>)['X-Api-Key']).toBe('********');
    expect((masked.headers as Record<string, string>).Accept).toBe('json');
    expect(masked.command).toBe('run');
  });
});

describe('builtin memory.query server', () => {
  it('ensureBuiltinMemoryQuery creates the system row once and refreshes config', () => {
    ensureBuiltinMemoryQuery(db);
    ensureBuiltinMemoryQuery(db); // 幂等
    const rows = db
      .prepare('SELECT * FROM mcp_server WHERE name = ?')
      .all(BUILTIN_MEMORY_QUERY) as { id: number; config: string }[];
    expect(rows).toHaveLength(1);
    const cfg = JSON.parse(rows[0].config) as { command: string; args: string[] };
    expect(cfg.command).toBe('node');
    expect(cfg.args[0]).toBe(bridgeScriptPath());
    expect(bridgeScriptPath()).toContain('memory-mcp-bridge');

    // 用户唯一可控的是 enabled：停用后不再进入生效集合
    db.prepare('UPDATE mcp_server SET enabled = 0 WHERE id = ?').run(rows[0].id);
    expect(collectEffectiveServers(db, 1).map((s) => s.name)).not.toContain(BUILTIN_MEMORY_QUERY);
    db.prepare('UPDATE mcp_server SET enabled = 1 WHERE id = ?').run(rows[0].id);
    expect(collectEffectiveServers(db, 1).map((s) => s.name)).toContain(BUILTIN_MEMORY_QUERY);
  });

  it('buildOcrMcpServers injects per-task env (dataDir + repoId) into the builtin server', () => {
    ensureBuiltinMemoryQuery(db);
    // 一个用户服务器 + 内置服务器并存
    createMcpServer(db, {
      name: 'codegraph',
      transport: 'stdio',
      config: { command: 'codegraph', args: ['serve'] },
    });
    const servers = collectEffectiveServers(db, 1);
    const mapped = buildOcrMcpServers(servers, { dataDir: '/tmp/crp-e2e/data', repoId: 7 });
    const builtin = mapped[BUILTIN_MEMORY_QUERY] as { env: string[]; command: string };
    expect(builtin.command).toBe('node');
    expect(builtin.env).toEqual(['CRP_DATA_DIR=/tmp/crp-e2e/data', 'CRP_REPO_ID=7']);
    // 用户服务器不受 ctx 影响
    const user = mapped.codegraph as { env: string[] };
    expect(user.env).toEqual([]);
  });

  it('builtin injection is audited like any other server (task_mcp_injection)', () => {
    ensureBuiltinMemoryQuery(db);
    const servers = collectEffectiveServers(db, 1);
    db.prepare(
      "INSERT INTO task (id, repo_id, node, trigger, status) VALUES (1, 1, '1', 'manual', 'succeeded')"
    ).run();
    recordMcpInjection(db, 1, servers);
    const audit = db
      .prepare('SELECT server_name FROM task_mcp_injection WHERE task_id = 1 ORDER BY server_id')
      .all() as { server_name: string }[];
    expect(audit.map((a) => a.server_name)).toContain(BUILTIN_MEMORY_QUERY);
  });
});
