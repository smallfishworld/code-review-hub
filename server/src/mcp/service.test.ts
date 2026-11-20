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
import { collectEffectiveServers, buildOcrMcpServers } from './injector.js';
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

  it('buildOcrMcpServers maps stdio and http shapes (env as KEY=VALUE array per ocr Go struct)', () => {
    const mapped = buildOcrMcpServers([
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
