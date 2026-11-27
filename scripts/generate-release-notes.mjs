#!/usr/bin/env node
/**
 * Generate standardized bilingual (English + 简体中文) GitHub Release Notes.
 *
 * Usage:
 *   node scripts/generate-release-notes.mjs \
 *     --tag v0.2.0 \
 *     [--prev-tag v0.1.0] \
 *     [--artifacts-dir ./release-assets] \
 *     [--changelog ./CHANGELOG.md] \
 *     [--repo owner/name] \
 *     [--out ./release-notes.md]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback = '') => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function git(cmdArgs) {
  try {
    return execFileSync('git', cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const TAG = opt('--tag', process.env.GITHUB_REF_NAME || `v${pkgJson.version}`);
const VERSION = TAG.replace(/^v/, '');
const OUT_PATH = opt('--out', '');
const ARTIFACTS_DIR = opt('--artifacts-dir', '');
const CHANGELOG_PATH = resolve(ROOT, opt('--changelog', 'CHANGELOG.md'));

function detectRepo() {
  const explicit = opt('--repo', process.env.GITHUB_REPOSITORY || '');
  if (explicit) return explicit;
  const remote = git(['remote', 'get-url', 'origin']);
  const m = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  return m ? m[1] : 'smallfishworld/code-review-hub';
}

function detectPrevTag(currentTag) {
  const explicit = opt('--prev-tag', '');
  if (explicit) return explicit;
  const allTags = git(['tag', '--sort=-v:refname'])
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = allTags.indexOf(currentTag);
  if (idx >= 0 && idx + 1 < allTags.length) return allTags[idx + 1];
  if (idx === -1 && allTags.length > 0) return allTags[0];
  return '';
}

const REPO = detectRepo();
const PREV_TAG = detectPrevTag(TAG);

/** Extract curated bilingual highlights from CHANGELOG.md if a section for VERSION exists. */
function extractChangelogSection(changelogPath, version) {
  if (!existsSync(changelogPath)) return { en: '', zh: '' };
  const text = readFileSync(changelogPath, 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^## \\[?v?${escaped}\\]?.*$`, 'm');
  const match = re.exec(text);
  if (!match) return { en: '', zh: '' };

  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextH2 = rest.search(/^## /m);
  const section = (nextH2 >= 0 ? rest.slice(0, nextH2) : rest).trim();

  const enMatch = section.match(/^### English\s*\n([\s\S]*?)(?=^### |\s*$)/m);
  const zhMatch = section.match(/^### (?:简体中文|中文)\s*\n([\s\S]*?)(?=^### |\s*$)/m);

  if (enMatch || zhMatch) {
    return {
      en: enMatch ? enMatch[1].trim() : '',
      zh: zhMatch ? zhMatch[1].trim() : '',
    };
  }
  return { en: section, zh: section };
}

/** Collect commits between PREV_TAG and HEAD (or TAG). */
function collectCommits(prevTag, currentTag) {
  const targetRef = git(['rev-parse', '--verify', currentTag]) ? currentTag : 'HEAD';
  const range = prevTag ? `${prevTag}..${targetRef}` : targetRef;
  const raw = git(['log', range, '--no-merges', '--pretty=format:%h%x09%s%x09%an']);
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author] = line.split('\t');
      return { hash, subject: subject ?? '', author: author ?? '' };
    });
}

function categorizeCommits(commits) {
  const buckets = {
    feat: [],
    fix: [],
    perf: [],
    docs: [],
    ci: [],
    other: [],
  };
  for (const c of commits) {
    const s = c.subject;
    if (/^feat(?:\([^)]*\))?!?:/i.test(s)) buckets.feat.push(c);
    else if (/^fix(?:\([^)]*\))?!?:/i.test(s)) buckets.fix.push(c);
    else if (/^(?:perf|refactor)(?:\([^)]*\))?!?:/i.test(s)) buckets.perf.push(c);
    else if (/^docs(?:\([^)]*\))?!?:/i.test(s)) buckets.docs.push(c);
    else if (/^(?:ci|build|release)(?:\([^)]*\))?!?:/i.test(s)) buckets.ci.push(c);
    else buckets.other.push(c);
  }
  return buckets;
}

function formatCommitLine(c) {
  const cleanSubject = c.subject.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '');
  return `- ${cleanSubject} (\`${c.hash}\`)`;
}

function renderCommitBuckets(buckets, labels) {
  const sections = [];
  const order = [
    ['feat', labels.feat],
    ['fix', labels.fix],
    ['perf', labels.perf],
    ['docs', labels.docs],
    ['ci', labels.ci],
    ['other', labels.other],
  ];
  for (const [key, title] of order) {
    if (buckets[key].length === 0) continue;
    sections.push(`#### ${title}\n\n${buckets[key].map(formatCommitLine).join('\n')}`);
  }
  return sections.join('\n\n');
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeAsset(filename) {
  if (/win-x64/i.test(filename)) return { os: 'Windows', arch: 'x64', osZh: 'Windows', archZh: 'x64' };
  if (/macos-arm64/i.test(filename)) return { os: 'macOS (Apple Silicon)', arch: 'arm64', osZh: 'macOS (Apple Silicon)', archZh: 'arm64' };
  if (/macos-x64/i.test(filename)) return { os: 'macOS (Intel)', arch: 'x64', osZh: 'macOS (Intel)', archZh: 'x64' };
  if (/linux-x64/i.test(filename)) return { os: 'Linux', arch: 'x64', osZh: 'Linux', archZh: 'x64' };
  if (/linux-arm64/i.test(filename)) return { os: 'Linux', arch: 'arm64', osZh: 'Linux', archZh: 'arm64' };
  return { os: 'Other', arch: '-', osZh: '其他', archZh: '-' };
}

function collectAssets(artifactsDir) {
  if (!artifactsDir || !existsSync(artifactsDir)) return [];
  const checksumMap = new Map();
  const sumsFile = join(artifactsDir, 'SHA256SUMS.txt');
  if (existsSync(sumsFile)) {
    for (const line of readFileSync(sumsFile, 'utf8').split(/\r?\n/)) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
      if (m) checksumMap.set(m[2].trim(), m[1].toLowerCase());
    }
  }
  const files = readdirSync(artifactsDir)
    .filter((f) => f.endsWith('.zip') || f.endsWith('.tar.gz'))
    .sort();
  return files.map((name) => {
    const fullPath = join(artifactsDir, name);
    const size = formatSize(statSync(fullPath).size);
    const sha256 = checksumMap.get(name) ?? sha256File(fullPath);
    const meta = describeAsset(name);
    return { name, size, sha256, ...meta };
  });
}

const changelog = extractChangelogSection(CHANGELOG_PATH, VERSION);
const commits = collectCommits(PREV_TAG, TAG);
const buckets = categorizeCommits(commits);
const assets = collectAssets(ARTIFACTS_DIR);

const enChanges = renderCommitBuckets(buckets, {
  feat: '✨ New Features',
  fix: '🐛 Bug Fixes',
  perf: '⚡ Improvements & Refactoring',
  docs: '📚 Documentation',
  ci: '📦 Build, Packaging & CI',
  other: '🔧 Other Changes',
});

const zhChanges = renderCommitBuckets(buckets, {
  feat: '✨ 新功能',
  fix: '🐛 问题修复',
  perf: '⚡ 性能优化与重构',
  docs: '📚 文档更新',
  ci: '📦 构建、打包与 CI',
  other: '🔧 其他变更',
});

const enAssetTable =
  assets.length > 0
    ? [
        '| Platform | Arch | Package | Size | SHA256 |',
        '| --- | --- | --- | --- | --- |',
        ...assets.map(
          (a) => `| ${a.os} | \`${a.arch}\` | \`${a.name}\` | ${a.size} | \`${a.sha256.slice(0, 16)}…\` |`
        ),
        '',
        '> Full checksums are available in `SHA256SUMS.txt`.',
      ].join('\n')
    : [
        '| Platform | Arch | Package |',
        '| --- | --- | --- |',
        `| Windows | \`x64\` | \`code-review-hub-win-x64-v${VERSION}.zip\` |`,
        `| macOS (Apple Silicon) | \`arm64\` | \`code-review-hub-macos-arm64-v${VERSION}.tar.gz\` |`,
        `| macOS (Intel) | \`x64\` | \`code-review-hub-macos-x64-v${VERSION}.tar.gz\` |`,
        `| Linux | \`x64\` | \`code-review-hub-linux-x64-v${VERSION}.tar.gz\` |`,
        `| Linux | \`arm64\` | \`code-review-hub-linux-arm64-v${VERSION}.tar.gz\` |`,
      ].join('\n');

const zhAssetTable =
  assets.length > 0
    ? [
        '| 平台 | 架构 | 软件包 | 大小 | SHA256 |',
        '| --- | --- | --- | --- | --- |',
        ...assets.map(
          (a) => `| ${a.osZh} | \`${a.archZh}\` | \`${a.name}\` | ${a.size} | \`${a.sha256.slice(0, 16)}…\` |`
        ),
        '',
        '> 完整校验和见附件 `SHA256SUMS.txt`。',
      ].join('\n')
    : [
        '| 平台 | 架构 | 软件包 |',
        '| --- | --- | --- |',
        `| Windows | \`x64\` | \`code-review-hub-win-x64-v${VERSION}.zip\` |`,
        `| macOS (Apple Silicon) | \`arm64\` | \`code-review-hub-macos-arm64-v${VERSION}.tar.gz\` |`,
        `| macOS (Intel) | \`x64\` | \`code-review-hub-macos-x64-v${VERSION}.tar.gz\` |`,
        `| Linux | \`x64\` | \`code-review-hub-linux-x64-v${VERSION}.tar.gz\` |`,
        `| Linux | \`arm64\` | \`code-review-hub-linux-arm64-v${VERSION}.tar.gz\` |`,
      ].join('\n');

const compareLink = PREV_TAG
  ? `https://github.com/${REPO}/compare/${PREV_TAG}...${TAG}`
  : `https://github.com/${REPO}/commits/${TAG}`;

const notes = `# Code Review Hub ${TAG}

[English](#english) | [简体中文](#简体中文)

---

## English

${changelog.en ? `### Highlights\n\n${changelog.en}\n` : ''}${enChanges ? `### What's Changed\n\n${enChanges}\n` : '### What\'s Changed\n\n- Initial release / maintenance update.\n'}
### Downloads

All portable packages bundle **Node.js**, **ocr CLI**, and **CodeGraph MCP** — no global Node or npm installation required.

${enAssetTable}

### Quick Start & Upgrade

- **Windows**: Extract the \`.zip\` and double-click \`start.cmd\` (or \`start-background.cmd\`).
- **macOS**: Extract the \`.tar.gz\`, run \`xattr -dr com.apple.quarantine code-review-hub\` if prompted by Gatekeeper, then run \`./start.command\` or \`./start.sh\`.
- **Linux**: Extract the \`.tar.gz\` and run \`./start.sh\` (a \`code-review-hub.service.example\` systemd unit is included).
- **Upgrade**: Stop the service, replace \`bin/\` (or \`node.exe\`), \`server/\`, \`web/\`, \`node_modules/\`, \`vendor/\`, and preserve your \`data/\` directory.

---

## 简体中文

${changelog.zh ? `### 更新亮点\n\n${changelog.zh}\n` : ''}${zhChanges ? `### 变更明细\n\n${zhChanges}\n` : '### 变更明细\n\n- 版本发布 / 常规维护更新。\n'}
### 软件包下载

所有免安装包均已内置 **Node.js**、**ocr CLI** 与 **CodeGraph MCP** 运行时，无需在目标机器安装 Node 或 npm。

${zhAssetTable}

### 快速启动与升级

- **Windows**：解压 \`.zip\` 后双击 \`start.cmd\`（后台常驻可使用 \`start-background.cmd\`）。
- **macOS**：解压 \`.tar.gz\`，如遇 Gatekeeper 拦截可执行 \`xattr -dr com.apple.quarantine code-review-hub\`，然后运行 \`./start.command\` 或 \`./start.sh\`。
- **Linux**：解压 \`.tar.gz\` 后运行 \`./start.sh\`（包内附 \`code-review-hub.service.example\` systemd 模板）。
- **升级**：停止服务后，覆盖 \`bin/\`（或 \`node.exe\`）、\`server/\`、\`web/\`、\`node_modules/\`、\`vendor/\`，保留 \`data/\` 目录即可，数据库迁移会在启动时自动执行。

---

**Full Changelog / 完整变更记录**: ${compareLink}
`;

if (OUT_PATH) {
  writeFileSync(resolve(OUT_PATH), notes, 'utf8');
  console.log(`[release-notes] wrote ${resolve(OUT_PATH)}`);
} else {
  process.stdout.write(notes);
}
