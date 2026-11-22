import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { codeGraphBridgeArgs, prepareReviewCodeGraph } from './codeGraph.js';
import { buildOcrMcpServers, collectEffectiveServers, ensureBuiltinCodeGraph } from './injector.js';

const task = {
  id: 1, repoId: 1, node: '1', trigger: 'manual', status: 'running', createdAt: '',
} as const;

async function explore(workspace: string, indexName: string, query: string, otherWorkspace: string) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'codegraph_explore', arguments: { query, projectPath: otherWorkspace },
    } },
  ];
  const child = spawn(process.execPath, [...codeGraphBridgeArgs(), workspace, indexName], {
    signal: AbortSignal.timeout(15_000),
  });
  const output = createInterface({ input: child.stdout });
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  child.stdin.on('error', () => { /* The MCP bridge may have exited. */ });
  const finished = new Promise<void>((resolve) => child.once('close', () => resolve()));
  const result = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => reject(new Error(`MCP bridge exited without a tool result: ${errors}`)));
    const responses = new Map<number, { result?: { tools?: unknown[] }; error?: unknown }>();
    output.on('line', (line) => {
      const message = JSON.parse(line);
      responses.set(message.id, message);
      if (!responses.has(2) || !responses.has(3)) return;
      try {
        expect(responses.get(2)?.result?.tools).toEqual([expect.objectContaining({ name: 'codegraph_explore' })]);
        expect(responses.get(3)?.error).toBeUndefined();
        resolve(JSON.stringify(responses.get(3)?.result));
      } catch (err) {
        reject(err);
      }
    });
  });
  child.stdin.write(messages.map((message) => JSON.stringify(message) + '\n').join(''));
  try {
    return await result;
  } finally {
    child.stdin.end();
    await finished;
  }
}

it('registers CodeGraph by default, preserves disabling and leaves a custom server alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crh-cg-registry-'));
  const db = openDatabase({ dataDir: dir });
  try {
    ensureBuiltinCodeGraph(db);
    const active = collectEffectiveServers(db, 1);
    expect(active.map(({ name }) => name)).toEqual(['codegraph']);
    expect(buildOcrMcpServers(active, { dataDir: dir, repoId: 1 })).toEqual({});
    expect(buildOcrMcpServers(active, { dataDir: dir, repoId: 1, codeGraphArgs: ['/checkout', '.graph'] }))
      .toMatchObject({ codegraph: { args: [...codeGraphBridgeArgs(), '/checkout', '.graph'] } });
    db.prepare("UPDATE mcp_server SET enabled = 0 WHERE name = 'codegraph'").run();
    ensureBuiltinCodeGraph(db);
    expect(collectEffectiveServers(db, 1)).toEqual([]);
    db.prepare("UPDATE mcp_server SET enabled = 1, config = ? WHERE name = 'codegraph'")
      .run(JSON.stringify({ command: 'custom', args: [] }));
    ensureBuiltinCodeGraph(db);
    expect(buildOcrMcpServers(collectEffectiveServers(db, 1))).toMatchObject({ codegraph: { command: 'custom' } });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('indexes real Git and SVN checkouts, refreshes changes, and scopes tool calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crh-cg-checkout-'));
  const git = join(dir, 'git');
  const svn = join(dir, 'svn');
  const data = join(dir, 'data');
  const cli = (cmd: string, args: string[], cwd = dir) =>
    execFileSync(cmd, args, { cwd, stdio: 'pipe' });
  const signal = new AbortController().signal;
  try {
    cli('git', ['init', git]);
    writeFileSync(join(git, 'math.ts'), 'export function gitAverage() { return 17; }\n');
    cli('git', ['add', 'math.ts'], git);
    cli('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], git);
    const svnRepo = join(dir, 'svn-repo');
    cli('svnadmin', ['create', svnRepo]);
    cli('svn', ['checkout', pathToFileURL(svnRepo).href, svn]);
    writeFileSync(join(svn, 'math.ts'), 'export function svnAverage() { return 23; }\n');
    cli('svn', ['add', 'math.ts'], svn);
    cli('svn', ['commit', '-m', 'fixture'], svn);

    const [gitWorkspace, gitIndex] = await prepareReviewCodeGraph(data, task, git, signal);
    const [svnWorkspace, svnIndex] = await prepareReviewCodeGraph(data, { ...task, repoId: 2 }, svn, signal);
    expect(gitWorkspace).toBe(realpathSync(git));
    expect(svnIndex).not.toBe(gitIndex);
    expect(await explore(gitWorkspace, gitIndex, 'gitAverage', svnWorkspace)).toContain('return 17');
    expect(await explore(svnWorkspace, svnIndex, 'svnAverage', gitWorkspace)).toContain('return 23');

    writeFileSync(join(git, 'math.ts'), 'export function gitAverage() { return 45; }\n');
    cli('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'next'], git);
    expect(await prepareReviewCodeGraph(data, task, git, signal)).toEqual([gitWorkspace, gitIndex]);
    expect(await explore(gitWorkspace, gitIndex, 'gitAverage', svnWorkspace)).toContain('return 45');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
