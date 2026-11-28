import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { codeGraphCommand, codeGraphEnv, isReviewIndexName } from './mcp/codeGraph.js';

const [rawWorkspace, indexName] = process.argv.slice(2);
if (rawWorkspace && (rawWorkspace.startsWith('-') || rawWorkspace.includes('\0'))) {
  throw new Error('Invalid CodeGraph workspace path');
}
const workspace = rawWorkspace ? resolve(rawWorkspace) : undefined;
if (workspace && !isReviewIndexName(indexName ?? '')) {
  throw new Error('CodeGraph requires a managed index');
}

const cli = codeGraphCommand([
  'serve', '--mcp', '--no-watch', '--no-telemetry',
  ...(workspace ? ['--path', workspace] : []),
]);
const child = spawn(cli.command, cli.args, {
  cwd: workspace,
  env: { ...codeGraphEnv(indexName), CODEGRAPH_HOST_PPID: String(process.pid) },
  shell: false,
  windowsHide: true,
});
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.stdin.on('error', () => { /* The server has exited. */ });

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    if (message.method === 'tools/call') {
      if (!workspace || message.params?.name !== 'codegraph_explore') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'CodeGraph tool unavailable for this workspace' },
        }) + '\n');
        return;
      }
      // CodeGraph supports cross-project queries by default. Reviews are pinned
      // to the checkout selected by the platform, regardless of model input.
      message.params.arguments = { ...message.params.arguments, projectPath: workspace };
    }
    child.stdin.write(JSON.stringify(message) + '\n');
  } catch {
    // Ignore malformed transport lines.
  }
});
input.on('close', () => child.stdin.end());
child.on('error', (err) => {
  console.error(err.message);
  process.exitCode = 1;
  input.close();
  process.stdin.destroy();
});
child.on('close', (code) => {
  process.exitCode ??= code ?? 1;
  input.close();
  process.stdin.destroy();
});
