import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.js';
import { probeMcpServer } from './probe.js';
import { createMcpServer } from './service.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Database.Database;
let scriptDir: string;

// A minimal MCP stdio server: newline-delimited JSON-RPC, answers
// initialize and tools/list, exits on stdin EOF.
const MOCK_SERVER = `#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'codegraph_explore' }, { name: 'codegraph_node' }] } }) + '\\n');
  }
});
rl.on('close', () => process.exit(0));
`;

// Never answers; stdin EOF does not end it (mimics a hung server).
const HANGING_SERVER = `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crp-probe-'));
  scriptDir = mkdtempSync(join(tmpdir(), 'crp-probe-bin-'));
  db = openDatabase({ dataDir: dir });
  for (const [name, body] of [
    ['mock-mcp.cjs', MOCK_SERVER],
    ['hang-mcp.cjs', HANGING_SERVER],
  ] as const) {
    const file = join(scriptDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(scriptDir, { recursive: true, force: true });
});

describe('probeMcpServer (stdio)', () => {
  it('handshakes and lists tools', async () => {
    const created = createMcpServer(db, {
      name: 'cg',
      transport: 'stdio',
      config: { command: process.execPath, args: [join(scriptDir, 'mock-mcp.cjs')] },
      timeoutSec: 10,
    });
    const res = await probeMcpServer(db, created.id);
    expect(res.ok).toBe(true);
    expect(res.tools).toEqual(['codegraph_explore', 'codegraph_node']);
  }, 20_000);

  it('reports a start failure for a missing command', async () => {
    const created = createMcpServer(db, {
      name: 'missing',
      transport: 'stdio',
      config: { command: '/nonexistent-mcp-binary-xyz' },
      timeoutSec: 2,
    });
    const res = await probeMcpServer(db, created.id);
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('start');
  }, 15_000);

  it('reports a timeout for a server that never answers', async () => {
    const created = createMcpServer(db, {
      name: 'hang',
      transport: 'stdio',
      config: { command: process.execPath, args: [join(scriptDir, 'hang-mcp.cjs')] },
      timeoutSec: 1,
    });
    const res = await probeMcpServer(db, created.id);
    expect(res.ok).toBe(false);
    expect(res.stage).toBe('timeout');
  }, 15_000);

  it('does not mutate the registry', async () => {
    const created = createMcpServer(db, {
      name: 'cg2',
      transport: 'stdio',
      config: { command: process.execPath, args: [join(scriptDir, 'mock-mcp.cjs')] },
    });
    await probeMcpServer(db, created.id);
    const row = db.prepare('SELECT * FROM mcp_server WHERE id = ?').get(created.id) as {
      config: string;
      updated_at: string;
      created_at: string;
    };
    expect(JSON.parse(row.config)).toEqual({
      command: process.execPath,
      args: [join(scriptDir, 'mock-mcp.cjs')],
    });
  }, 20_000);
});
