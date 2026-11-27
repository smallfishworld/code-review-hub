#!/usr/bin/env node
/**
 * Build a self-contained Windows package for offline / intranet deployment.
 *
 *   node scripts/package-win.mjs [--out <dir>] [--no-zip] [--with-svn <dir>]
 *
 * The result is a directory (and a .zip next to it) that runs with no
 * pre-installed Node, npm, ocr or SVN:
 *
 *   code-review-hub/
 *     node.exe                  bundled Node runtime
 *     start.cmd                 double-click launcher
 *     server/                   compiled server
 *     web/dist/                 built console (served by the server)
 *     node_modules/             production dependencies only
 *     vendor/ocr/ocr.exe        the ocr CLI (renamed from opencodereview.exe)
 *     vendor/svn/bin/           portable SVN (optional, --with-svn)
 *     data/                     created on first run
 *
 * start.cmd prepends vendor/ocr and vendor/svn/bin to PATH for the server
 * process, so the platform's own dependency probe finds them without the
 * operator touching the system PATH.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBundledCodeGraph } from './package-codegraph.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT_ROOT = resolve(opt('--out', join(ROOT, 'dist-win')));
const PKG_NAME = 'code-review-hub';
const PKG_DIR = join(OUT_ROOT, PKG_NAME);
const WITH_SVN = opt('--with-svn', '');
const MAKE_ZIP = !flag('--no-zip');
const PKG_VERSION = opt(
  '--version',
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
).replace(/^v/, '');

const log = (msg) => console.log(`[package] ${msg}`);
const fail = (msg) => {
  console.error(`[package] ERROR ${msg}`);
  process.exit(1);
};

/** Run a command and return stdout. */
function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** Recursively sum file sizes. */
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// ---------------------------------------------------------------- preflight
log(`output: ${PKG_DIR}`);
if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail('this packager requires a Windows x64 Node runtime');
}

// Build first so the package always contains current code.
log('building server + web …');
run('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) fail('server build missing');
if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) fail('web build missing');

// Locate the ocr native binary. The npm package ships it under the platform
// package; we copy it as ocr.exe so `which('ocr')` finds a real PE image.
function findOcrExe() {
  let globalRoot = '';
  try {
    globalRoot = run('npm', ['root', '-g'], { shell: true }).trim();
  } catch {
    // ignore
  }
  const candidates = [
    join(ROOT, 'node_modules', '@smallfishworld', 'ocr-win32-x64', 'bin', 'opencodereview.exe'),
    globalRoot &&
      join(
        globalRoot,
        '@smallfishworld',
        'open-code-review-svn',
        'node_modules',
        '@smallfishworld',
        'ocr-win32-x64',
        'bin',
        'opencodereview.exe'
      ),
    globalRoot &&
      join(globalRoot, '@smallfishworld', 'ocr-win32-x64', 'bin', 'opencodereview.exe'),
    join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@smallfishworld',
      'open-code-review-svn',
      'node_modules',
      '@smallfishworld',
      'ocr-win32-x64',
      'bin',
      'opencodereview.exe'
    ),
    join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@smallfishworld',
      'ocr-win32-x64',
      'bin',
      'opencodereview.exe'
    ),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const ocrExe = findOcrExe();
if (!ocrExe) {
  fail(
    'opencodereview.exe not found. Install it first:\n' +
      '  npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1'
  );
}
log(`ocr binary: ${ocrExe}`);

// ---------------------------------------------------------------- assemble
log('cleaning output …');
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });

log('copying server …');
// Keep the `server/dist/` shape: index.ts locates the console at
// `../../web/dist` relative to its own file, which only holds in this layout.
cpSync(join(ROOT, 'server', 'dist'), join(PKG_DIR, 'server', 'dist'), { recursive: true });

log('copying web console …');
cpSync(join(ROOT, 'web', 'dist'), join(PKG_DIR, 'web', 'dist'), { recursive: true });

log('copying node runtime …');
const nodeExe = process.execPath;
cpSync(nodeExe, join(PKG_DIR, 'node.exe'));
log(`  node ${process.version} (${mb(statSync(nodeExe).size)})`);

log('copying production dependencies …');
// `npm ls --parseable --omit=dev` lists the exact production tree; copying
// only those packages keeps the bundle small and avoids dev-only binaries.
const prodPaths = run('npm', ['ls', '--omit=dev', '--parseable', '--all'], { shell: true })
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((p) => p !== ROOT && p.startsWith(join(ROOT, 'node_modules')));
for (const src of prodPaths) {
  const rel = src.slice(join(ROOT, 'node_modules').length + 1);
  const dest = join(PKG_DIR, 'node_modules', rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}
log(`  ${prodPaths.length} packages`);
log(`  bundled CodeGraph ${await verifyBundledCodeGraph(PKG_DIR)}`);

// better-sqlite3 ships prebuilds for every platform; keep only win32-x64.
const bs3Prebuilds = join(PKG_DIR, 'node_modules', 'better-sqlite3', 'prebuilds');
if (existsSync(bs3Prebuilds)) {
  for (const f of readdirSync(bs3Prebuilds)) {
    if (f !== 'win32-x64.node') rmSync(join(bs3Prebuilds, f), { force: true });
  }
  log('  trimmed better-sqlite3 prebuilds to win32-x64');
}

log('copying ocr …');
mkdirSync(join(PKG_DIR, 'vendor', 'ocr'), { recursive: true });
cpSync(ocrExe, join(PKG_DIR, 'vendor', 'ocr', 'ocr.exe'));

if (WITH_SVN) {
  const svnSrc = resolve(WITH_SVN);
  if (!existsSync(join(svnSrc, 'svn.exe'))) fail(`--with-svn ${svnSrc} has no svn.exe`);
  log(`copying SVN from ${svnSrc} …`);
  cpSync(svnSrc, join(PKG_DIR, 'vendor', 'svn', 'bin'), { recursive: true });
} else {
  log('no --with-svn given: the bundle expects svn on the target PATH');
}

// ---------------------------------------------------------------- launcher
const startCmd = `@ECHO OFF
SETLOCAL
TITLE Code Review Platform
CD /D "%~dp0"

REM Put the bundled ocr and SVN first on PATH so the platform's dependency
REM probe finds them, without changing the machine's own PATH.
SET "PATH=%~dp0vendor\\ocr;%~dp0vendor\\svn\\bin;%PATH%"

REM Data lives next to the launcher so the whole folder is portable.
IF "%DATA_DIR%"=="" SET "DATA_DIR=%~dp0data"

REM Bind to all interfaces so other intranet hosts can reach the console.
IF "%HOST%"=="" SET "HOST=0.0.0.0"
IF "%PORT%"=="" SET "PORT=3000"
REM Report links inside notifications; change to the address users actually open.
IF "%PUBLIC_BASE_URL%"=="" SET "PUBLIC_BASE_URL=http://%COMPUTERNAME%:%PORT%"

ECHO.
ECHO   Code Review Platform
ECHO   Console:  http://localhost:%PORT%/
ECHO   Data:     %DATA_DIR%
ECHO.
ECHO   Close this window to stop the service.
ECHO.

"%~dp0node.exe" "%~dp0server\\dist\\index.js"
SET "EXITCODE=%ERRORLEVEL%"

ECHO.
ECHO Service stopped (exit code %EXITCODE%).
PAUSE
ENDLOCAL
`;
writeFileSync(join(PKG_DIR, 'start.cmd'), startCmd.replace(/\r?\n/g, '\r\n'), 'utf8');

// A console-less variant for running as a background service / scheduled task.
const startHidden = `@ECHO OFF
SETLOCAL
CD /D "%~dp0"
SET "PATH=%~dp0vendor\\ocr;%~dp0vendor\\svn\\bin;%PATH%"
IF "%DATA_DIR%"=="" SET "DATA_DIR=%~dp0data"
IF "%HOST%"=="" SET "HOST=0.0.0.0"
IF "%PORT%"=="" SET "PORT=3000"
IF "%PUBLIC_BASE_URL%"=="" SET "PUBLIC_BASE_URL=http://%COMPUTERNAME%:%PORT%"
start "" /B "%~dp0node.exe" "%~dp0server\\dist\\index.js"
ENDLOCAL
`;
writeFileSync(join(PKG_DIR, 'start-background.cmd'), startHidden.replace(/\r?\n/g, '\r\n'), 'utf8');

// ---------------------------------------------------------------- docs
const pkgVersion = PKG_VERSION;
const readme = `# 代码评审平台（Windows 免安装包 v${pkgVersion}）

解压后直接运行 \`start.cmd\`，浏览器打开 http://localhost:3000/ 。

## 包含内容

| 目录 | 说明 |
| --- | --- |
| \`node.exe\` | 内置 Node.js ${process.version}，无需在目标机安装 Node |
| \`server/\` | 平台服务端（已编译） |
| \`web/dist/\` | Web 控制台（由服务端直接托管） |
| \`node_modules/\` | 生产依赖（已裁剪为 win32-x64） |
| \`vendor/ocr/ocr.exe\` | ocr 评审 CLI（open-code-review v1.13.8-svn.1） |
| \`node_modules/@colbymchenry/\` | 内置 CodeGraph MCP 与本地索引运行时 |
| \`vendor/svn/bin/\` | 便携版 SVN 1.14.5${WITH_SVN ? '' : '（本包未内置，需自行安装 SVN >= 1.9 并加入 PATH）'} |
| \`data/\` | 首次启动自动创建：数据库、密钥、工作副本、报告 |

## 启动

双击 \`start.cmd\`。窗口关闭即停止服务。

需要后台常驻时用 \`start-background.cmd\`，或注册为计划任务。

## 首次配置

1. 打开控制台，进入「设置」设置管理员口令（未设置前控制台是开放的）。
2. 「模型服务」新增一个 Provider（API 地址 / 模型名 / API Key），并「设为默认」。
3. 「仓库管理」新增 SVN 或 Git 仓库，保存时会验证连通性。
4. 「监控规则」按需配置上库人员白名单、路径前缀。
5. 「通知配置」按需配置 SMTP 或聊天机器人 Webhook。

## 环境变量

在启动前设置即可覆盖默认值：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| \`PORT\` | \`3000\` | 监听端口 |
| \`HOST\` | \`0.0.0.0\` | 监听地址 |
| \`DATA_DIR\` | \`<安装目录>\\data\` | 数据目录 |
| \`PUBLIC_BASE_URL\` | \`http://<计算机名>:<PORT>\` | 通知里的报告链接前缀，建议改成实际访问地址 |
| \`AUTH_REQUIRED\` | \`true\` | 设为 \`false\` 可关闭口令校验（不推荐） |

## 依赖自检

启动日志会打印依赖检测结果；控制台「设置 → 依赖状态」可随时重新检测。
\`ocr\` 为必需项，\`svn\`/\`git\` 按仓库类型按需使用。

## 升级

停止服务，用新包覆盖 \`server/\`、\`web/\`、\`node_modules/\`、\`vendor/\`，保留 \`data/\` 即可。
数据库迁移在启动时自动执行。
`;
writeFileSync(join(PKG_DIR, 'README.md'), readme, 'utf8');

// ---------------------------------------------------------------- zip
const total = dirSize(PKG_DIR);
log(`package size: ${mb(total)}`);

if (MAKE_ZIP) {
  const zipPath = join(OUT_ROOT, `${PKG_NAME}-win-x64-v${pkgVersion}.zip`);
  rmSync(zipPath, { force: true });
  log(`zipping → ${zipPath} …`);
  // Compress-Archive is available on every supported Windows; it is slow but
  // dependency-free. -CompressionLevel Optimal keeps the 58 MB ocr binary
  // from dominating the archive.
  run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${PKG_DIR}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'inherit' }
  );
  log(`zip: ${mb(statSync(zipPath).size)}`);
}

log('done.');
