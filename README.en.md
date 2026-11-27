# code-review-hub (Automated AI Code Review Platform)

[简体中文](README.md) | **English**

An automated AI code review platform built on [`ocr`](https://github.com/smallfishworld/open-code-review-svn) (the SVN fork of `open-code-review`): automatically invokes AI review engines for every commit/revision pushed to **SVN / Git** repositories, supporting manual single-node & range reviews, author/path-filtered automatic monitoring, web report browsing, and email / chat bot notifications.

- **Bilingual Web Console**: Full **English** and **Simplified Chinese** UI with browser language detection and one-click switching
- **Pluggable Review Engines**: Unified `ReviewEngine` adapter interface (`ocr` as the first adapter), resolved in 3-tier priority: Monitor Rule → Repository → Global Default
- **MCP Server Integration**: Centralized management of MCP servers (`stdio` / `http`) injected into the review engine so review agents can invoke MCP tools (e.g. bundled CodeGraph symbol search), with connectivity testing and per-task call auditing
- **Project Memory**: Per-repository knowledge distilled across 6 categories (architecture / convention / pitfall / suppression / history / glossary), retrieved and injected before review, LLM-distilled after review, and closed-loop false-positive suppression
- **Single-Process Deployment**: HTTP API + Web Console + Task Runner + Repository Poller + Notification Dispatcher
- **Full Persistence**: SQLite + raw JSON report files, recoverable across service restarts
- **Cross-Platform**: Runs on **Linux**, **Windows**, and **macOS** (with self-contained portable release packages for all three platforms)

---

## 5-Minute Quick Start: From SVN / Git Commit to Review Notification

Pick a repository you use and verify the full end-to-end flow: **Push code → Auto-trigger AI review → Receive report link**. Below uses email as an example. First start the service following Section 2, and prepare a test repo, LLM API credentials, and an SMTP account.

1. **Add a repository and configure an LLM Provider.** On first visit, open **Settings** to set an admin password and sign in. In **Repositories**, add a repo: for **SVN**, enter the monitored path URL (e.g. `.../trunk`); for **Git**, enter the remote URL and monitored branch (e.g. `main`). In **LLM Providers**, configure API Base URL, Model, Protocol, and API Key, test connectivity, and click **Set Default**.
2. **Configure notifications.** In **Notifications**, add and enable an email channel with SMTP details and test recipients, save, and click **Send Test**. Note that trigger rules are global—matching completions notify all enabled channels. If recipients open reports from other hosts, set `PUBLIC_BASE_URL` to an externally reachable address when starting the service.
3. **Enable monitoring and push a test commit.** In **Monitor Rules**, select the repo, set Poll Interval to `30` seconds and Initial Backtrack Nodes to `0`. Optionally configure Author Whitelist and Path Prefixes: **SVN** uses the committer username; **Git** uses the commit author name (`git log -1 --format=%an`), not the GitHub username. When both are set, commits must match both (AND). Enable the rule, wait one poll cycle to establish the baseline, then commit to the monitored SVN path or push to the monitored Git branch.
4. **Verify report and email.** Find the task in **Tasks & Reports** by SVN revision (e.g. `r123`) or Git commit SHA. Once succeeded, confirm the test inbox received the email and open the report link. If no task was created, check monitor logs; if the task succeeded without email, check notification logs.

> **Author whitelist decides whose commits are reviewed; notification channels decide who receives reports.** The platform does not automatically email commit authors.

---

## 1. Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | 22.13+ (22.x), 24.x, or 26+ (CI: 22.23.5) | Backend runtime and frontend build |
| `ocr` | **>= 1.12.13** (`1.13.8-svn.1` recommended) | Review executor; `< 1.12.13` only supports SVN working-copy mode; **`< 1.13` automatically skips MCP & project memory injection** (reviews still run, degradation is recorded on the task) |
| `svn` | **>= 1.9** (1.14.x recommended) | Required only for SVN repos (`ocr` uses `svn info --show-item`) |
| `git` | >= 2.20 | Required only for Git repos |

> On startup, the platform probes these commands and prints a dependency report (also available at `GET /api/deps` and in **Settings → Dependency Status**).

### Install `ocr`

```bash
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1
ocr --version    # Expected: open-code-review v1.13.8-svn.1 ...
```

Configure LLM credentials for `ocr` via either method:

1. **Recommended**: Add a provider in **LLM Providers** in the Web Console and mark it as default. You can also assign multiple providers to a repository (concurrent reviews are load-balanced across the pool, with the first item preferred). Each review slot uses an isolated `ocr` HOME directory.
   - `ocr` requires a non-empty API Key even for unauthenticated local endpoints (e.g. Ollama / llama-server). Enter any placeholder string in the API Key field.
2. Fallback: If no provider is configured in the platform, `ocr` falls back to `~/.opencodereview/config.json`.

### Install SVN

- **Windows**: `ocr` requires `svn --show-item` (SVN >= 1.9). Older `svn` bundled with TortoiseSVN may be insufficient; install Apache Subversion 1.14.x and add its `bin` folder to `PATH`:
  ```powershell
  $env:PATH = "D:\tools\svn-1.14.5\bin;$env:PATH"
  svn --version --quiet   # 1.14.5
  ```
- **Linux**: `sudo apt install subversion` / `sudo dnf install subversion`
- **macOS**: `brew install subversion`

---

## 2. Installation & Startup

### 2.1 Portable Release Packages (Recommended)

Download the pre-built self-contained archive for your platform from [GitHub Releases](https://github.com/smallfishworld/code-review-hub/releases). Every package bundles **Node.js**, **`ocr` CLI**, and **CodeGraph MCP**—no global Node/npm installation needed:

| Platform | Arch | Archive | Launcher |
| --- | --- | --- | --- |
| Windows | `x64` | `code-review-hub-win-x64-v*.zip` | `start.cmd` / `start-background.cmd` |
| macOS (Apple Silicon) | `arm64` | `code-review-hub-macos-arm64-v*.tar.gz` | `./start.command` / `./start.sh` |
| macOS (Intel) | `x64` | `code-review-hub-macos-x64-v*.tar.gz` | `./start.command` / `./start.sh` |
| Linux | `x64` | `code-review-hub-linux-x64-v*.tar.gz` | `./start.sh` / systemd unit |
| Linux | `arm64` | `code-review-hub-linux-arm64-v*.tar.gz` | `./start.sh` / systemd unit |

### 2.2 Build from Source

#### Linux

```bash
sudo apt update && sudo apt install -y subversion git
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1

cd /opt/code-review-hub
npm ci --include=optional
npm --prefix web ci
npm run build

PORT=3000 DATA_DIR=/var/lib/code-review-hub npm start
```

Open `http://<server-host>:3000` in your browser.

#### Windows

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# Install Apache Subversion 1.14.x and add bin/ to PATH if using SVN
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1

cd D:\code\code-review-hub
npm ci --include=optional
npm --prefix web ci
npm run build

$env:PORT="3000"; $env:DATA_DIR="D:\code\code-review-hub\data"; npm start
```

Open `http://127.0.0.1:3000`.

#### macOS

```bash
brew install node subversion
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1

cd /opt/code-review-hub
npm ci --include=optional
npm --prefix web ci
npm run build

PORT=3000 DATA_DIR=/var/lib/code-review-hub npm start
```

Open `http://127.0.0.1:3000`.

### 2.3 Local Packaging & GitHub Release Pipeline

Build a self-contained portable package locally on the target OS/architecture:

```bash
npm run package:win                              # Windows x64 (.zip)
npm run package:mac -- --arch arm64              # macOS arm64 / x64 (.tar.gz)
npm run package:linux -- --arch x64              # Linux x64 / arm64 (.tar.gz)
```

**Automated GitHub Release Pipeline** (`.github/workflows/release.yml`):

1. Optionally add curated English & Chinese release highlights under `## [X.Y.Z] - YYYY-MM-DD` in [`CHANGELOG.md`](CHANGELOG.md).
2. Push a semver tag (e.g. `git tag v0.2.0 && git push origin v0.2.0`) or trigger the **Release** workflow manually via `workflow_dispatch`.
3. The pipeline automatically:
   - Runs lint, unit/integration tests, and full build.
   - Packages portable bundles for **Windows x64**, **macOS arm64**, **macOS x64**, **Linux x64**, and **Linux arm64**.
   - Generates `SHA256SUMS.txt` and standardized **bilingual (English & 简体中文)** release notes via `scripts/generate-release-notes.mjs`.
   - Publishes the GitHub Release with all archives and checksums attached.

### 2.4 Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `REVIEW_MAX_CONCURRENCY` | `4` | Global max concurrent review tasks across all repos |
| `DATA_DIR` | `<cwd>/data` | Data directory: SQLite DB, encryption keys, reports, workcopies, `ocr-home` |
| `AUTH_REQUIRED` | `true` | Set to `false` to disable admin password auth (trusted environments only) |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | External base URL used for report links in notifications |

Data directory layout:

```
data/
├── app.db              # SQLite (repos / tasks / reports / monitor / notifications / engines / MCP / memory)
├── keys/secret.key     # AES-256-GCM master key (generated on first run, mode 0600)
├── reports/<task>.json # Raw ocr review output
├── workcopies/<repo>/  # Per-repo SVN working copies / Git clone caches
├── memory/<repo-id>/   # Project memory markdown projection (SQLite is source of truth)
└── ocr-home/<repo-id>/ # Isolated ocr HOME per repo/slot (LLM Provider + MCP config)
```

Back up by copying `DATA_DIR` as a whole (`keys/secret.key` and `app.db` must be kept together to decrypt stored credentials).

---

## 3. Initial Setup

1. Open the console. Before an admin password is set, the console is in bootstrap mode.
2. Go to **Settings** and set an admin password (at least 6 characters). Once set, all `/api/*` endpoints require authentication (except `/api/health` and `/api/auth/*`).
3. Configure in order:
   - **Repositories**: Add SVN or Git repositories (connectivity is verified via `svn info` / `git ls-remote` before saving).
   - **LLM Providers**: Add API Base URL / Model / Protocol / Key, test connectivity, and set as default.
   - **Review Engines**: Default `ocr` engine is auto-registered on first start.
   - **MCP Servers**: Built-in CodeGraph is enabled by default; add custom `stdio` / `http` MCP servers as needed.
   - **Notifications**: Configure SMTP email and/or chat bot webhooks, and select the trigger rule (All / Failed only / Succeeded only).
   - **Monitor Rules**: Set poll interval (`>= 30s`), author whitelist, path prefixes, and initial backtrack nodes, then enable monitoring.
   - **Manual Trigger / Tasks & Reports**: Trigger single-node or range reviews, inspect issues, retry failed tasks, and submit feedback (**False Positive** / **Fixed** / **Won't Fix**).
   - **Project Memory** (optional): Click **Memory** on any repository row to manage entries, generate a project profile, or preview injected context.

### 3.1 Auth Extension Point

Authentication uses bcrypt-hashed admin passwords with in-memory session tokens (`server/src/auth/authenticator.ts`). To integrate OA/LDAP/SSO, implement the `Authenticator` interface and inject it into `buildAuthRoutes(db, { loginRequired })` without modifying business routes.

---

## 4. Notification Channels

Notifications are dispatched asynchronously once a task reaches a terminal state (`succeeded` / `failed`), with 3 retries (500ms / 1500ms backoff). Failures are logged and never affect the review task itself.

### 4.1 Email (SMTP)

Configure SMTP host, port (`587` / `465`), SSL/TLS, sender, recipients (comma/newline-separated), username, and password (encrypted at rest). Click **Send Test** to verify.

### 4.2 Chat Bot (Generic Webhook)

Works with any enterprise chat platform supporting webhooks (Slack, Teams, DingTalk, WeCom, Feishu, etc.). Supported template placeholders:

| Placeholder | Meaning |
| --- | --- |
| `{{repo}}` | Repository name |
| `{{node}}` | SVN revision or Git commit SHA |
| `{{author}}` | Commit author |
| `{{status}}` | Task status |
| `{{summary}}` | Review summary (or error message on failure) |
| `{{report_url}}` | Report URL (based on `PUBLIC_BASE_URL`) |

Two template modes:
- **Plain text**: Rendered text is wrapped in `{"text": "<rendered>"}`.
- **Raw JSON**: Templates starting with `{` or `[` are parsed with `JSON.parse` after placeholder rendering and sent as the request body.

Example (Markdown webhook):

```json
{
  "msgtype": "markdown",
  "markdown": {
    "content": "**Code Review** {{repo}} {{node}} {{status}}\n> Author: {{author}}\n> Summary: {{summary}}\n> [View Report]({{report_url}})"
  }
}
```

---

## 5. Review & Monitoring Behavior

- **Manual Single Node**: Enter an SVN revision number or a full/unique short Git commit SHA.
- **Manual Range**: Enter `from`/`to` revisions or commits. Creates one task per node in chronological order (old → new). Already-reviewed nodes are skipped unless `force` is requested.
- **Auto Monitoring**: Starts from current HEAD on first enable (optionally backtracks N commits), then polls incrementally. Author whitelist and path prefixes use **AND** semantics when both are configured. Unmatched nodes are logged as skipped; cursor position persists across restarts.
- **Concurrency & Isolation**: Each repository defaults to **2** concurrent review slots (configurable per repo; `1` for serial), bounded globally by `REVIEW_MAX_CONCURRENCY` (default `4`). Each slot has its own isolated working copy, `ocr` HOME, and CodeGraph index.
- **Restart Recovery**: In-flight `running` tasks are marked `failed` (`service restarted`); `queued` tasks resume automatically.

---

## 6. Review Engines, MCP Servers & Project Memory

### 6.1 Review Engines (Pluggable)

- Auto-registers the default `ocr` engine on startup.
- **3-tier resolution**: Monitor Rule → Repository → Global Default. If a resolved engine is disabled or missing, the task fails explicitly without silent fallback.
- **Version gating**: Probes `ocr --version` before execution; `< 1.13` skips MCP and memory injection cleanly.

### 6.2 MCP Servers

- Built-in [CodeGraph](https://github.com/colbymchenry/codegraph) is auto-registered and bundled in production dependencies and portable release packages.
- Supports `stdio` (local command) and `http` (Streamable HTTP) transports, global or per-repository scope, optional tool allowlists, one-click connectivity testing, per-task audit logs, and automatic secret masking.
- **Security Note**: MCP servers execute commands or network calls with the service account's privileges—only register trusted MCP servers.

### 6.3 Project Memory

- **6 categories**: `architecture`, `convention`, `pitfall`, `suppression`, `history`, `glossary`.
- **Dual storage**: SQLite (with FTS5 trigram full-text search) as source of truth, projected to editable markdown files under `data/memory/<repo-id>/`.
- **Pre-review injection**: Recalls relevant entries for changed files within a 1500-token budget via `ocr --background-file`.
- **Feedback loop & deterministic suppression**: False positives aggregate by fingerprint into `suppression` memories and deterministically filter matching issues before report storage. `fixed` generates `history` memories; `wont_fix` requires a rationale (up to 500 chars) and generates `pitfall` memories.
- **Built-in `memory.query` MCP bridge**: Allows review agents (`ocr >= 1.13`) to query repository memory on demand (`memory_search`, `memory_get`, `memory_stats`).

---

## 7. Cross-Platform Smoke Verification

`scripts/smoke.mjs` creates temporary SVN & Git repos, a local webhook receiver, and a local SMTP stub to verify 10 stages end-to-end:

```bash
SMOKE_SERVER_CMD="node server/dist/index.js" \
SMOKE_SERVER_CWD=/opt/code-review-hub \
SMOKE_DATA_DIR=/tmp/crp-smoke/data \
SMOKE_DIR=/tmp/crp-smoke/scratch \
BASE_URL=http://127.0.0.1:3996 \
node scripts/smoke.mjs
```

---

## 8. Development

```bash
npm run dev        # Start backend (tsx watch :3000) + frontend (Vite :5173)
npm test           # Run Vitest server unit/integration tests
npm run lint       # Run ESLint (server) & oxlint (web)
npm run build      # Build server TypeScript + web SPA
```

Directory structure:

```
server/src/
├── index.ts            # Bootstrap: deps → DB → engines → queue → routes → static SPA
├── auth/               # Pluggable admin password authentication
├── crypto/             # AES-256-GCM credential encryption
├── db/                 # SQLite migrations
├── deps/               # svn/git/ocr probing & version checks
├── engines/            # Pluggable review engines & ocr adapter
├── mcp/                # MCP registry, injector, connectivity prober
├── memory/             # Project memory: store / recall / inject / feedback / distill / suppress
├── monitor/            # Polling, filtering, monitor state
├── notifications/      # Channels, SMTP/webhook adapters, dispatcher
├── providers/          # LLM Provider configs & isolated ocr HOME
├── repos/              # Repository CRUD & connectivity verification
├── tasks/              # Task queue, ocr runner, report parser, manual triggers
└── vcs/                # svn / git wrappers
web/src/
├── i18n/               # zh-CN / en translations & LanguageSwitcher
├── components/         # Layout, ConfirmDialog, NodePicker, Toast
└── pages/              # Repos / Monitor / Trigger / Tasks / Providers / Engines / MCP / Memory / Notifications / Logs / Settings
scripts/                # Packaging (win/mac/linux), bilingual release notes, smoke tests
.github/workflows/      # CI & cross-platform Release pipelines
```

---

## 9. Troubleshooting

| Symptom | Resolution |
| --- | --- |
| Startup log shows `ocr [MISSING]` | Run `npm i -g @smallfishworld/open-code-review-svn@1.13.8-svn.1` and verify `ocr --version` |
| Startup log shows `ocr [BROKEN]` version too low | Upgrade `ocr` to `>= 1.12.13` (`>= 1.13` for MCP & memory injection) |
| `svn [BROKEN]` or `"is not a git repository or SVN working copy"` | Ensure `svn --version` is `>= 1.9` (`--show-item` support) |
| Task fails with `LLM completion error` | Verify API Base URL, Model, and Key in **LLM Providers** using **Test Connection** |
| Task fails with disabled/missing engine | Re-enable the engine in **Review Engines** or update the repo/rule binding |
| MCP connectivity test fails | Check command/args (`stdio`), URL/headers (`http`), or increase timeout seconds |
| Project Memory shows FTS unavailable | Environment lacks FTS5/trigram; full-text search automatically falls back to `LIKE` |
| Re-login required after restart | Sessions are stored in memory by design |
