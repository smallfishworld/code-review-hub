import { execFileSync } from 'node:child_process';
import { cpSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Refuse to produce an offline bundle if npm skipped the platform package. */
export async function verifyBundledCodeGraph(packageDir) {
  packageDir = realpathSync(packageDir);
  const { codeGraphCommand } = await import(pathToFileURL(join(packageDir, 'server', 'dist', 'mcp', 'codeGraph.js')));
  const { command, args } = codeGraphCommand(['--version']);
  for (const path of [command, args[3]]) {
    const location = relative(packageDir, path);
    if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
      throw new Error('CodeGraph 未复制到免安装包，请安装当前平台的 npm 可选依赖后重试');
    }
  }
  const version = execFileSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
  cpSync(new URL('../licenses/codegraph.txt', import.meta.url),
    join(packageDir, 'node_modules', '@colbymchenry', 'codegraph', 'LICENSE'));
  return version;
}
