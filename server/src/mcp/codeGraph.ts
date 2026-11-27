import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { TaskRecord } from '../tasks/taskQueue.js';
import { workspaceKey } from '../repos/sourceVersion.js';

export const BUILTIN_CODEGRAPH = 'codegraph';
const require = createRequire(import.meta.url);
const sourceRun = import.meta.url.endsWith('.ts');

export function codeGraphBridgeArgs(): string[] {
  const extension = sourceRun ? 'ts' : 'js';
  const entry = fileURLToPath(new URL(`../codegraph-mcp-bridge.${extension}`, import.meta.url));
  // Node's ESM --import requires a file URL for Windows drive-letter paths.
  return sourceRun ? ['--import', pathToFileURL(require.resolve('tsx')).href, entry] : [entry];
}

const run = promisify(execFile);
const INDEX_PREFIX = '.codegraph-crh-';

/** Resolve only the platform package installed with the app, including its private runtime. */
export function codeGraphCommand(args: string[]): { command: string; args: string[] } {
  const fromShim = createRequire(require.resolve('@colbymchenry/codegraph/package.json'));
  const pkg = `@colbymchenry/codegraph-${process.platform}-${process.arch}`;
  const runtime = process.platform === 'win32' ? 'node.exe' : 'node';
  return {
    command: fromShim.resolve(`${pkg}/${runtime}`),
    args: [
      '--liftoff-only', '--disable-warning=ExperimentalWarning', '--max-semi-space-size=16',
      fromShim.resolve(`${pkg}/lib/dist/bin/codegraph.js`), ...args,
    ],
  };
}

export function codeGraphEnv(indexName?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEGRAPH_DIR: indexName || '.codegraph',
    CODEGRAPH_TELEMETRY: '0',
    CODEGRAPH_NO_UPDATE_CHECK: '1',
    CODEGRAPH_NO_DAEMON: '1',
    CODEGRAPH_MCP_TOOLS: 'explore',
  };
}

export function isReviewIndexName(value: string): boolean {
  return /^\.codegraph-crh-[a-f0-9-]{36}$/.test(value);
}

/** Keep the generated index name in app data, outside the repository being reviewed. */
function reviewIndexName(dataDir: string, task: TaskRecord): string {
  const dir = join(dataDir, 'codegraph');
  const marker = join(dir, workspaceKey(task.repoId, task.sourceVersion, task.workspaceSlot));
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(marker, INDEX_PREFIX + randomUUID(), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const value = readFileSync(marker, 'utf8');
  if (!isReviewIndexName(value)) throw new Error('CodeGraph 索引标识无效');
  return value;
}

/** Prepare the index after Git checkout / SVN update and before OCR requests tools. */
export async function prepareReviewCodeGraph(
  dataDir: string, task: TaskRecord, workspace: string, signal: AbortSignal
): Promise<[workspace: string, indexName: string]> {
  const root = realpathSync(workspace);
  const indexName = reviewIndexName(dataDir, task);
  const dir = join(root, indexName);
  const existing = lstatSync(dir, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error('CodeGraph 索引路径不是普通目录');
  const db = lstatSync(join(dir, 'codegraph.db'), { throwIfNoEntry: false });
  if (db && !db.isFile()) throw new Error('CodeGraph 索引文件无效');
  const args = db ? ['sync', '--quiet', root] : ['init', '--yes', '--local-only', root];
  const cli = codeGraphCommand(args);
  await run(cli.command, cli.args, {
    cwd: root,
    env: codeGraphEnv(indexName),
    signal,
    timeout: 120_000,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  return [root, indexName];
}
