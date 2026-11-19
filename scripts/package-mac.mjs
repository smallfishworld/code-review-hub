#!/usr/bin/env node
/**
 * Build a self-contained macOS package for offline deployment.
 *
 *   node scripts/package-mac.mjs [--out <dir>] [--no-zip] [--arch arm64|x64]
 *
 * Must run ON a macOS machine (it bundles the local Node runtime and the
 * darwin ocr native binary). The result is a directory (and a .tar.gz next
 * to it) that runs with no pre-installed Node, npm or ocr:
 *
 *   codereview-hub/
 *     bin/node                  bundled Node runtime
 *     start.command             double-click launcher (Finder-openable)
 *     start.sh                  terminal launcher / launchd target
 *     server/                   compiled server
 *     web/dist/                 built console (served by the server)
 *     node_modules/             production dependencies only (darwin prebuilds)
 *     vendor/ocr/ocr            the ocr CLI (darwin native binary)
 *     data/                     created on first run
 *
 * SVN is NOT bundled: macOS ships no svn by default and there is no canonical
 * portable build — the package expects `brew install subversion` and documents
 * it. The launcher falls back to the system PATH when vendor/svn is absent.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const OUT_ROOT = resolve(opt('--out', join(ROOT, 'dist-mac')));
const PKG_NAME = 'codereview-hub';
const PKG_DIR = join(OUT_ROOT, PKG_NAME);
const ARCH = opt('--arch', process.arch === 'arm64' ? 'arm64' : 'x64');
const MAKE_ZIP = !flag('--no-zip');

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
log(`output: ${PKG_DIR} (arch: ${ARCH})`);
if (process.platform !== 'darwin') {
  fail('this packager builds a macOS bundle and must run on macOS');
}

// Build first so the package always contains current code.
log('building server + web …');
run('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) fail('server build missing');
if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) fail('web build missing');

// Locate the ocr darwin binary. The npm package ships it under the platform
// package as `ocr` (a Mach-O executable, no extension).
function findOcrBin() {
  const candidates = [
    join(ROOT, 'node_modules', `@smallfishworld`, `ocr-darwin-${ARCH}`, 'bin', 'opencodereview'),
    join(
      process.env.HOME ?? '',
      '.npm-global',
      'lib',
      'node_modules',
      '@smallfishworld',
      'open-code-review-svn',
      'node_modules',
      '@smallfishworld',
      `ocr-darwin-${ARCH}`,
      'bin',
      'opencodereview'
    ),
    '/usr/local/lib/node_modules/@smallfishworld/open-code-review-svn/node_modules/@smallfishworld/' +
      `ocr-darwin-${ARCH}` +
      '/bin/opencodereview',
    '/opt/homebrew/lib/node_modules/@smallfishworld/open-code-review-svn/node_modules/@smallfishworld/' +
      `ocr-darwin-${ARCH}` +
      '/bin/opencodereview',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const ocrBin = findOcrBin();
if (!ocrBin) {
  fail(
    `opencodereview (darwin-${ARCH}) not found. Install it first:\n` +
      '  npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1'
  );
}
log(`ocr binary: ${ocrBin}`);

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
const nodeBin = process.execPath;
cpSync(nodeBin, join(PKG_DIR, 'bin', 'node'), { recursive: false });
chmodSync(join(PKG_DIR, 'bin', 'node'), 0o755);
log(`  node ${process.version} (${mb(statSync(nodeBin).size)})`);

log('copying production dependencies …');
// `npm ls --parseable --omit=dev` lists the exact production tree; copying
// only those packages keeps the bundle small and avoids dev-only binaries.
// better-sqlite3 resolves its prebuild at runtime via require, and npm ls may
// return symlinks for workspace hoisting — copy with follow-symlinks off and
// dereference explicitly when needed.
const prodPaths = run('npm', ['ls', '--omit=dev', '--parseable', '--all'], { shell: true })
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((p) => p !== ROOT && p.startsWith(join(ROOT, 'node_modules')));
for (const src of prodPaths) {
  const rel = src.slice(join(ROOT, 'node_modules').length + 1);
  const dest = join(PKG_DIR, 'node_modules', rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, verbatimSymlinks: false });
}
log(`  ${prodPaths.length} packages`);

// better-sqlite3 ships prebuilds for every platform; keep only darwin ones
// (both arm64 and x64 so one package can serve both Mac generations when
// built with --arch matching the binary; node resolves by process.arch).
const bs3Prebuilds = join(PKG_DIR, 'node_modules', 'better-sqlite3', 'prebuilds');
if (existsSync(bs3Prebuilds)) {
  for (const f of readdirSync(bs3Prebuilds)) {
    if (!f.startsWith('darwin')) rmSync(join(bs3Prebuilds, f), { force: true });
  }
  log('  trimmed better-sqlite3 prebuilds to darwin');
}

log('copying ocr …');
mkdirSync(join(PKG_DIR, 'vendor', 'ocr'), { recursive: true });
cpSync(ocrBin, join(PKG_DIR, 'vendor', 'ocr', 'ocr'));
chmodSync(join(PKG_DIR, 'vendor', 'ocr', 'ocr'), 0o755);

log('no bundled SVN on macOS: run `brew install subversion` on the target machine');

// ---------------------------------------------------------------- launcher
// start.sh: the canonical entry (launchd / terminal). POSIX sh, no bashisms.
const startSh = `#!/bin/sh
# Code Review Platform (macOS) — terminal / launchd launcher.
cd "$(dirname "$0")" || exit 1

# Put the bundled ocr first on PATH so the platform's dependency probe finds
# it, without changing the machine's own PATH. SVN is expected from Homebrew
# (brew install subversion) and stays wherever brew put it.
PATH="$PWD/vendor/ocr:$PATH"
export PATH

# Data lives next to the launcher so the whole folder is portable.
: "\${DATA_DIR:=$PWD/data}"
export DATA_DIR

# Bind to all interfaces so other intranet hosts can reach the console.
: "\${HOST:=0.0.0.0}"
: "\${PORT:=3000}"
# Report links inside notifications; change to the address users actually open.
: "\${PUBLIC_BASE_URL:=http://$(hostname -s):$PORT}"
export HOST PORT PUBLIC_BASE_URL

exec "$PWD/bin/node" "$PWD/server/dist/index.js"
`;
writeFileSync(join(PKG_DIR, 'start.sh'), startSh, 'utf8');
chmodSync(join(PKG_DIR, 'start.sh'), 0o755);

// start.command: double-clickable from Finder — opens Terminal and runs
// start.sh with a friendly banner (a plain exec would close the window at
// exit, so run the server in the foreground and pause afterwards).
const startCommand = `#!/bin/sh
# Double-click launcher (Finder → Terminal).
DIR="$(cd "$(dirname "$0")" && pwd)"
echo
echo "  Code Review Platform"
echo "  Console:  http://localhost:\${PORT:-3000}/"
echo "  Data:     \${DATA_DIR:-$DIR/data}"
echo
echo "  Close this Terminal window to stop the service."
echo
"$DIR/start.sh"
STATUS=$?
echo
echo "Service stopped (exit code $STATUS)."
echo "Press any key to close this window…"
read -r -n 1
`;
writeFileSync(join(PKG_DIR, 'start.command'), startCommand, 'utf8');
chmodSync(join(PKG_DIR, 'start.command'), 0o755);

// launchd plist template so the operator can run it as a user service.
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codereview.platform</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PKG_DIR}/start.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>3000</string>
    <key>HOST</key>
    <string>0.0.0.0</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${PKG_DIR}/data/logs-launchd.out</string>
  <key>StandardErrorPath</key>
  <string>${PKG_DIR}/data/logs-launchd.err</string>
</dict>
</plist>
`;
writeFileSync(join(PKG_DIR, 'com.codereview.platform.plist.example'), plist, 'utf8');

// ---------------------------------------------------------------- docs
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const readme = `# 代码评审平台（macOS 免安装包 v${pkgVersion}，${ARCH}）

终端运行 \`./start.command\`（或双击），浏览器打开 http://localhost:3000/ 。

## 包含内容

| 路径 | 说明 |
| --- | --- |
| \`bin/node\` | 内置 Node.js ${process.version}，无需在目标机安装 Node |
| \`server/\` | 平台服务端（已编译） |
| \`web/dist/\` | Web 控制台（由服务端直接托管） |
| \`node_modules/\` | 生产依赖（已裁剪为 darwin 预编译） |
| \`vendor/ocr/ocr\` | ocr 评审 CLI（open-code-review v1.13.8-svn.1，darwin-${ARCH}） |
| \`start.sh\` | 终端 / launchd 启动脚本 |
| \`start.command\` | Finder 双击启动 |
| \`com.codereview.platform.plist.example\` | launchd 用户服务模板 |
| \`data/\` | 首次启动自动创建：数据库、密钥、工作副本、报告 |

## 前置依赖

macOS 系统不自带 SVN，需要安装一次：

    brew install subversion

Git 已随 Xcode Command Line Tools 提供（\`xcode-select --install\`）。

## 启动

    ./start.command          # 双击或终端运行，Ctrl-C 停止
    ./start.sh               # 供 launchd / nohup 等使用

launchd 常驻：

    cp com.codereview.platform.plist.example ~/Library/LaunchAgents/com.codereview.platform.plist
    # 编辑其中的路径后：
    launchctl load ~/Library/LaunchAgents/com.codereview.platform.plist

## 首次配置

1. 打开控制台，进入「设置」设置管理员口令（未设置前控制台是开放的）。
2. 「模型服务」新增一个 Provider（API 地址 / 模型名 / API Key），并「设为默认」。
3. 「仓库管理」新增 SVN 或 Git 仓库，保存时会验证连通性。
4. 「监控规则」按需配置上库人员白名单、路径前缀。
5. 「通知配置」按需配置 SMTP 或聊天机器人 Webhook。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| \`PORT\` | \`3000\` | 监听端口 |
| \`HOST\` | \`0.0.0.0\` | 监听地址 |
| \`DATA_DIR\` | \`<安装目录>/data\` | 数据目录 |
| \`PUBLIC_BASE_URL\` | \`http://<主机名>:<PORT>\` | 通知里的报告链接前缀 |
| \`AUTH_REQUIRED\` | \`true\` | 设为 \`false\` 可关闭口令校验（不推荐） |

## Gatekeeper 提示

首次运行若提示"无法验证开发者"，右键 \`start.command\` →「打开」，或执行：

    xattr -dr com.apple.quarantine .

## 升级

停止服务，用新包覆盖 \`server/\`、\`web/\`、\`node_modules/\`、\`vendor/\`，保留 \`data/\` 即可。
数据库迁移在启动时自动执行。
`;
writeFileSync(join(PKG_DIR, 'README.md'), readme, 'utf8');

// ---------------------------------------------------------------- archive
const total = dirSize(PKG_DIR);
log(`package size: ${mb(total)}`);

if (MAKE_ZIP) {
  // tar.gz preserves the executable bits that zip+unzip may drop on macOS.
  const tarPath = join(OUT_ROOT, `${PKG_NAME}-macos-${ARCH}-v${pkgVersion}.tar.gz`);
  rmSync(tarPath, { force: true });
  log(`archiving → ${tarPath} …`);
  run('tar', ['-czf', tarPath, '-C', OUT_ROOT, PKG_NAME], { stdio: 'inherit' });
  log(`tar.gz: ${mb(statSync(tarPath).size)}`);
}

log('done.');
