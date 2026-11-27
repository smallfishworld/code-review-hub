#!/usr/bin/env node
/**
 * Build a self-contained Linux package for offline / server deployment.
 *
 *   node scripts/package-linux.mjs [--out <dir>] [--no-zip] [--arch x64|arm64] [--version <ver>]
 *
 * Must run ON a Linux machine matching the target architecture (it bundles the
 * local Node runtime, linux native dependencies, CodeGraph, and the linux ocr
 * binary). The result is a directory (and a .tar.gz next to it) that runs with
 * no pre-installed Node, npm, or ocr:
 *
 *   code-review-hub/
 *     bin/node                        bundled Node runtime
 *     start.sh                        terminal / systemd launcher
 *     code-review-hub.service.example systemd unit template
 *     server/                         compiled server
 *     web/dist/                       built console (served by the server)
 *     node_modules/                   production dependencies only (linux prebuilds)
 *     vendor/ocr/ocr                  the ocr CLI (linux native binary)
 *     data/                           created on first run
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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

const OUT_ROOT = resolve(opt('--out', join(ROOT, 'dist-linux')));
const PKG_NAME = 'code-review-hub';
const PKG_DIR = join(OUT_ROOT, PKG_NAME);
const ARCH = opt('--arch', process.arch === 'arm64' ? 'arm64' : 'x64');
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
log(`output: ${PKG_DIR} (arch: ${ARCH}, version: ${PKG_VERSION})`);
if (process.platform !== 'linux') {
  fail('this packager builds a Linux bundle and must run on Linux');
}
if (ARCH !== process.arch) {
  fail('run the packager with a Node runtime matching the requested architecture');
}

// Build first so the package always contains current code.
log('building server + web …');
run('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) fail('server build missing');
if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) fail('web build missing');

// Locate the ocr linux binary.
function findOcrBin() {
  let globalRoot = '';
  try {
    globalRoot = run('npm', ['root', '-g']).trim();
  } catch {
    // ignore
  }
  const pkgDirName = `ocr-linux-${ARCH}`;
  const candidates = [
    join(ROOT, 'node_modules', '@smallfishworld', pkgDirName, 'bin', 'opencodereview'),
    globalRoot &&
      join(
        globalRoot,
        '@smallfishworld',
        'open-code-review-svn',
        'node_modules',
        '@smallfishworld',
        pkgDirName,
        'bin',
        'opencodereview'
      ),
    globalRoot && join(globalRoot, '@smallfishworld', pkgDirName, 'bin', 'opencodereview'),
    join(
      process.env.HOME ?? '',
      '.npm-global',
      'lib',
      'node_modules',
      '@smallfishworld',
      'open-code-review-svn',
      'node_modules',
      '@smallfishworld',
      pkgDirName,
      'bin',
      'opencodereview'
    ),
    `/usr/local/lib/node_modules/@smallfishworld/open-code-review-svn/node_modules/@smallfishworld/${pkgDirName}/bin/opencodereview`,
    `/usr/lib/node_modules/@smallfishworld/open-code-review-svn/node_modules/@smallfishworld/${pkgDirName}/bin/opencodereview`,
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const ocrBin = findOcrBin();
if (!ocrBin) {
  fail(
    `opencodereview (linux-${ARCH}) not found. Install it first:\n` +
      '  npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1'
  );
}
log(`ocr binary: ${ocrBin}`);

// ---------------------------------------------------------------- assemble
log('cleaning output …');
rmSync(PKG_DIR, { recursive: true, force: true });
mkdirSync(PKG_DIR, { recursive: true });

log('copying server …');
cpSync(join(ROOT, 'server', 'dist'), join(PKG_DIR, 'server', 'dist'), { recursive: true });

log('copying web console …');
cpSync(join(ROOT, 'web', 'dist'), join(PKG_DIR, 'web', 'dist'), { recursive: true });

log('copying node runtime …');
const nodeBin = process.execPath;
mkdirSync(join(PKG_DIR, 'bin'), { recursive: true });
cpSync(nodeBin, join(PKG_DIR, 'bin', 'node'), { recursive: false });
chmodSync(join(PKG_DIR, 'bin', 'node'), 0o755);
log(`  node ${process.version} (${mb(statSync(nodeBin).size)})`);

log('copying production dependencies …');
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
log(`  bundled CodeGraph ${await verifyBundledCodeGraph(PKG_DIR)}`);

// Trim better-sqlite3 prebuilds to linux only if present.
const bs3Prebuilds = join(PKG_DIR, 'node_modules', 'better-sqlite3', 'prebuilds');
if (existsSync(bs3Prebuilds)) {
  for (const f of readdirSync(bs3Prebuilds)) {
    if (!f.startsWith('linux')) rmSync(join(bs3Prebuilds, f), { force: true });
  }
  log('  trimmed better-sqlite3 prebuilds to linux');
}

log('copying ocr …');
mkdirSync(join(PKG_DIR, 'vendor', 'ocr'), { recursive: true });
cpSync(ocrBin, join(PKG_DIR, 'vendor', 'ocr', 'ocr'));
chmodSync(join(PKG_DIR, 'vendor', 'ocr', 'ocr'), 0o755);

// ---------------------------------------------------------------- launcher
const startSh = `#!/bin/sh
# Code Review Hub (Linux) — terminal / systemd launcher.
cd "$(dirname "$0")" || exit 1

# Put the bundled ocr first on PATH so the platform's dependency probe finds it.
PATH="$PWD/vendor/ocr:$PATH"
export PATH

# Data lives next to the launcher so the whole folder is portable.
: "\${DATA_DIR:=$PWD/data}"
export DATA_DIR

# Bind to all interfaces so other intranet hosts can reach the console.
: "\${HOST:=0.0.0.0}"
: "\${PORT:=3000}"
# Report links inside notifications; change to the address users actually open.
: "\${PUBLIC_BASE_URL:=http://$(hostname -s 2>/dev/null || echo localhost):$PORT}"
export HOST PORT PUBLIC_BASE_URL

exec "$PWD/bin/node" "$PWD/server/dist/index.js"
`;
writeFileSync(join(PKG_DIR, 'start.sh'), startSh, 'utf8');
chmodSync(join(PKG_DIR, 'start.sh'), 0o755);

const systemdUnit = `[Unit]
Description=Code Review Hub
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/code-review-hub
ExecStart=/opt/code-review-hub/start.sh
Restart=on-failure
RestartSec=5
Environment=PORT=3000
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/var/lib/code-review-hub
# Environment=PUBLIC_BASE_URL=http://your-host:3000

[Install]
WantedBy=multi-user.target
`;
writeFileSync(join(PKG_DIR, 'code-review-hub.service.example'), systemdUnit, 'utf8');

// ---------------------------------------------------------------- docs
const readme = `# Code Review Hub (Linux Portable Bundle v${PKG_VERSION}, ${ARCH})

Run \`./start.sh\` and open http://localhost:3000/ in your browser.

---

## English

### Contents

| Path | Description |
| --- | --- |
| \`bin/node\` | Bundled Node.js ${process.version} (no system Node required) |
| \`server/\` | Compiled backend server |
| \`web/dist/\` | Built Web console (served directly by the backend) |
| \`node_modules/\` | Production dependencies (linux-${ARCH}) |
| \`vendor/ocr/ocr\` | Bundled \`ocr\` CLI (linux-${ARCH}) |
| \`node_modules/@colbymchenry/\` | Bundled CodeGraph MCP & local indexing runtime |
| \`start.sh\` | Terminal / systemd launcher |
| \`code-review-hub.service.example\` | systemd service unit template |
| \`data/\` | Created on first run: SQLite DB, encryption keys, workcopies, reports |

### Prerequisites

Install \`subversion\` and/or \`git\` depending on your repository types:

\`\`\`bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y subversion git

# RHEL / Rocky / Fedora
sudo dnf install -y subversion git
\`\`\`

### Start & systemd Service

\`\`\`bash
./start.sh
\`\`\`

To run as a systemd service:

\`\`\`bash
sudo cp code-review-hub.service.example /etc/systemd/system/code-review-hub.service
# Edit paths & PUBLIC_BASE_URL inside the service file, then:
sudo systemctl daemon-reload
sudo systemctl enable --now code-review-hub
\`\`\`

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| \`PORT\` | \`3000\` | Listen port |
| \`HOST\` | \`0.0.0.0\` | Bind address |
| \`DATA_DIR\` | \`<install-dir>/data\` | Data directory |
| \`PUBLIC_BASE_URL\` | \`http://<hostname>:<PORT>\` | Report URL prefix in notifications |
| \`AUTH_REQUIRED\` | \`true\` | Set \`false\` to disable admin password auth (trusted networks only) |

### Upgrade

Stop the service, replace \`bin/\`, \`server/\`, \`web/\`, \`node_modules/\`, \`vendor/\`, and keep \`data/\`. Database migrations run automatically on startup.

---

## 简体中文

解压后运行 \`./start.sh\`，浏览器打开 http://localhost:3000/ 。

### 前置依赖

按仓库类型安装 \`subversion\` 和/或 \`git\`（\`sudo apt install -y subversion git\`）。

### systemd 常驻服务

\`\`\`bash
sudo cp code-review-hub.service.example /etc/systemd/system/code-review-hub.service
# 按实际安装路径编辑后：
sudo systemctl daemon-reload
sudo systemctl enable --now code-review-hub
\`\`\`

### 升级

停止服务，用新包覆盖 \`bin/\`、\`server/\`、\`web/\`、\`node_modules/\`、\`vendor/\`，保留 \`data/\` 即可。数据库迁移在启动时自动执行。
`;
writeFileSync(join(PKG_DIR, 'README.md'), readme, 'utf8');

// ---------------------------------------------------------------- archive
const total = dirSize(PKG_DIR);
log(`package size: ${mb(total)}`);

if (MAKE_ZIP) {
  const tarPath = join(OUT_ROOT, `${PKG_NAME}-linux-${ARCH}-v${PKG_VERSION}.tar.gz`);
  rmSync(tarPath, { force: true });
  log(`archiving → ${tarPath} …`);
  run('tar', ['-czf', tarPath, '-C', OUT_ROOT, PKG_NAME], { stdio: 'inherit' });
  log(`tar.gz: ${mb(statSync(tarPath).size)}`);
}

log('done.');
