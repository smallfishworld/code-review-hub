# Changelog / 更新日志

All notable changes to **code-review-hub** will be documented in this file.
When preparing a new release, add a `## [X.Y.Z] - YYYY-MM-DD` section with `### English` and `### 简体中文` subsections — the GitHub Actions release workflow will automatically include them as the release highlights.

---

## [Unreleased]

### English

- **Web Console Internationalization (i18n)**: Full English and Simplified Chinese (`zh-CN` / `en`) support across all console pages, dialogs, toasts, and date formatting, with browser language auto-detection and a persistent language switcher.
- **English Documentation**: Added a complete English README (`README.en.md`) with bidirectional language links.
- **Cross-Platform Release Pipeline**: Added `scripts/package-linux.mjs` (x64 & arm64) and GitHub Actions CI & Release workflows (`.github/workflows/ci.yml`, `.github/workflows/release.yml`) to build and publish self-contained packages for Windows, macOS (arm64 & x64), and Linux (x64 & arm64) with SHA256 checksums.
- **Standardized Bilingual Release Notes**: Added `scripts/generate-release-notes.mjs` and `.github/release.yml` for structured English & Chinese release notes.

### 简体中文

- **Web 控制台国际化（i18n）**：全量支持简体中文与英文（`zh-CN` / `en`）切换，覆盖所有页面、弹窗、提示与日期格式，支持浏览器语言自动探测与本地持久化。
- **英文文档支持**：新增完整英文版文档 `README.en.md`，并与 `README.md` 双向互链。
- **全平台发布打包流水线**：新增 Linux 打包脚本 `scripts/package-linux.mjs`（支持 x64 / arm64）以及 GitHub Actions CI 与发布工作流（`.github/workflows/ci.yml`、`.github/workflows/release.yml`），自动构建并发布 Windows、macOS（arm64 / x64）、Linux（x64 / arm64）免安装包与 SHA256 校验文件。
- **规范化中英文 Release Note**：新增 `scripts/generate-release-notes.mjs` 与 `.github/release.yml`，自动生成规范的中英文双语发布说明。

---

## [0.1.0] - 2026-04-01

### English

- Initial release of **code-review-hub**: automated AI code review platform for SVN and Git repositories built on `ocr`.
- Pluggable review engine architecture, MCP server integration (bundled CodeGraph), project memory with deterministic suppression, scheduled monitoring, manual single/range triggers, and SMTP/webhook notifications.

### 简体中文

- **code-review-hub** 首个版本发布：基于 `ocr` 的 SVN / Git 自动化 AI 代码评审平台。
- 支持可插拔评审引擎、MCP 服务器集成（内置 CodeGraph）、项目记忆与确定性误报抑制、自动监控轮询、手动单节点/区间触发以及邮件/聊天机器人通知。
