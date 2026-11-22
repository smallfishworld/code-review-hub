# codereview-hub（自动化代码评审平台）

基于 [`ocr`](https://github.com/smallfishworld/open-code-review-svn)（open-code-review 的 SVN fork）构建的自动化代码评审平台：对 **SVN / Git** 仓库上库的每个节点（revision / commit）调用评审引擎做 AI 评审，支持手动触发单节点 / 区间评审、按人员与路径过滤的自动监控、评审报告浏览，以及邮件 / 聊天机器人通知。

- **可插拔评审引擎**：统一的 `ReviewEngine` 适配器接口（ocr 为首个适配器），按 监控规则 → 仓库 → 全局默认 三级选择引擎
- **MCP 服务器集成**：平台统一管理 MCP 服务器（stdio / http），评审时注入引擎配置，使评审智能体可调用 MCP 工具（如 codegraph 符号检索）；连通性测试与逐任务调用审计
- **项目记忆**：按仓库沉淀六类记忆（架构 / 约定 / 坑点 / 误报抑制 / 历史修复 / 术语），评审前检索注入、评审后 LLM 蒸馏，误报反馈闭环让评审随使用越来越准
- 单进程部署：HTTP API + Web 控制台 + 任务执行器 + 仓库轮询监控 + 通知发送器
- 全部状态持久化（SQLite + 报告 JSON 文件），服务重启可恢复
- 同一套代码运行在 **Linux**、**Windows** 与 **macOS**

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | >= 20（推荐 22 LTS） | 服务与前端构建 |
| `ocr` | **>= 1.12.13**（推荐最新 `1.13.8-svn.1`） | 评审执行器；低于 1.12.13 的版本只支持 SVN 工作副本模式；**< 1.13 时 MCP 注入与项目记忆注入自动降级跳过**（评审照常执行，任务记录标注降级原因） |
| `svn` | **>= 1.9**（推荐 1.14.x） | 仅监控/评审 SVN 仓库时需要；`ocr` 用 `svn info --show-item` 探测工作副本 |
| `git` | 任意较新版本（>= 2.20） | 仅监控/评审 Git 仓库时需要 |

> 平台启动时会自动探测上述命令并打印检测报告（`GET /api/deps` 也可查询）。`ocr` 是必需项，`svn`/`git` 按仓库类型条件需要；版本过低会明确提示"版本过低：需要 >= x.y"。

### 安装 `ocr`

```bash
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1
ocr --version    # 期望输出 open-code-review v1.13.8-svn.1 ...
```

`ocr` 自身需要 LLM 配置，两种方式任选其一：

1. **推荐**：在平台 Web 控制台「LLM Provider」页配置 API 地址 / 模型 / Key 并设为默认。可在仓库设置中为仓库指定一个 Provider。每个评审执行槽使用独立的 ocr HOME 和模型配置。
2. 不配置 Provider 时，`ocr` 回退到运行账号自己的 `~/.opencodereview/config.json`。

### 安装 SVN（Windows）

`ocr` 依赖 `svn` 的 `--show-item` 选项（SVN >= 1.9）。TortoiseSVN 自带的旧版 svn 可能不满足要求，建议安装 Apache Subversion 官方发行版并把其 `bin` 目录加入 `PATH`，例如：

```powershell
# 解压 apache-subversion-1.14.x 到 D:\tools\svn-1.14.5，然后
$env:PATH = "D:\tools\svn-1.14.5\bin;$env:PATH"
svn --version --quiet   # 1.14.5
```

Linux 直接使用发行版包：`apt install subversion` / `yum install subversion`。

macOS 使用 Homebrew：`brew install subversion`。

---

## 2. 安装与启动

### 2.1 Linux

```bash
# 1) 安装依赖（以 Debian/Ubuntu 为例）
sudo apt update && sudo apt install -y subversion git
node -v                      # 需 >= 20
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1

# 2) 获取代码并安装依赖
cd /opt/codereview-hub
npm ci
npm --prefix web ci

# 3) 构建（服务端 TypeScript + 前端 SPA）
npm run build

# 4) 启动
PORT=3000 DATA_DIR=/var/lib/codereview-hub npm start
```

浏览器访问 `http://<服务器地址>:3000`。

### 2.2 Windows

```powershell
# 1) 安装依赖（PowerShell，管理员）
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# SVN：安装 Apache Subversion 1.14.x 并把 bin 加入 PATH（见上）
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1

# 2) 获取代码并安装依赖
cd D:\code\codereview-hub
npm ci
npm --prefix web ci

# 3) 构建
npm run build

# 4) 启动
$env:PORT="3000"; $env:DATA_DIR="D:\code\codereview-hub\data"; npm start
```

浏览器访问 `http://127.0.0.1:3000`。

> Windows 上 `npm start` 通过 `node server/dist/index.js` 启动；平台内部用 `which()` 解析 `ocr.cmd`（npm 的 `.cmd` shim 需要 shell 才能执行），无需手工改脚本。

### 2.3 macOS

```bash
# 1) 安装依赖
brew install node subversion     # 或从 nodejs.org 安装 Node >= 20
npm install -g @smallfishworld/open-code-review-svn@1.13.8-svn.1

# 2) 获取代码并安装依赖
cd /opt/codereview-hub
npm ci
npm --prefix web ci

# 3) 构建
npm run build

# 4) 启动
PORT=3000 DATA_DIR=/var/lib/codereview-hub npm start
```

浏览器访问 `http://127.0.0.1:3000`。

免安装打包（用与目标架构一致的 Node 在 macOS 上执行，产物为 `dist-mac/codereview-hub-macos-<arch>-v*.tar.gz`，内置 Node、ocr 与 CodeGraph，SVN 需目标机 `brew install subversion`）：

```bash
node scripts/package-mac.mjs [--arch arm64|x64]
```

包内 `start.command` 可双击启动，`start.sh` 供 launchd 使用（包内附 plist 模板）。

### 2.4 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（内网部署可改为具体网卡地址） |
| `REVIEW_MAX_CONCURRENCY` | `4` | 服务实例同时运行的评审任务总上限 |
| `DATA_DIR` | `<当前目录>/data` | 数据目录：SQLite、加密密钥、报告、工作副本/克隆、`ocr-home` |
| `AUTH_REQUIRED` | `true` | 设为 `false` 可关闭管理员口令鉴权（仅限受信环境） |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | 通知中"报告链接"使用的外部地址，部署后请改成实际访问地址 |

数据目录结构：

```
data/
├── app.db              # SQLite（仓库/任务/报告索引/监控/通知/引擎/MCP/记忆）
├── keys/secret.key     # AES-256-GCM 密钥文件（首次启动生成，POSIX 权限 0600）
├── reports/<task>.json # ocr 输出的评审原文
├── workcopies/<repo>/  # 每仓库的 SVN 工作副本 / Git 克隆缓存
├── memory/<repo-id>/   # 项目记忆 markdown 投影（SQLite 为准，可手工编辑后重载）
└── ocr-home/<repo-id>/ # 每仓库隔离的 ocr 配置 HOME（LLM Provider + MCP 注入）
```

备份时整体复制 `DATA_DIR` 即可（`keys/secret.key` 与 `app.db` 必须成对保留，否则已存凭据无法解密）。

---

## 3. 初始配置

1. 打开控制台，首次访问时**未设置管理员口令**，控制台处于引导状态。
2. 进入「系统设置」设置管理员口令（至少 6 位）。设置后所有 `/api/*` 接口都需要登录（`/api/health`、`/api/auth/*` 除外）。
3. 登录后按顺序配置：
   - **仓库管理**：新增 SVN 或 Git 仓库（保存前会做连通性验证：`svn info` / `git ls-remote`，失败不保存）。
   - **LLM Provider**：API 地址 / 模型 / 协议 / Key，设为默认；可点「测试连接」。
   - **评审引擎**：首次启动自动注册默认 ocr 引擎并设为全局默认；可按需新增引擎、按仓库 / 监控规则覆盖（详见第 6 节）。
   - **MCP 服务器**：内置 CodeGraph 默认启用。可按需注册其他服务器并绑定仓库（详见第 6 节）。
   - **通知配置**：邮件渠道、聊天机器人渠道，选择触发规则（全部完成 / 仅失败 / 仅成功）。
   - **监控规则**：轮询间隔（>= 30 秒）、人员白名单、路径前缀、回溯节点数，启用后开始轮询。
   - **手动触发 / 任务列表**：单节点或区间触发，查看任务状态与报告；报告 issue 行尾可标记「误报 / 已修复」喂给项目记忆。
   - **项目记忆**（可选）：仓库详情行点「项目记忆」进入管理页，可手工维护条目、生成项目画像、预览注入内容（详见第 6 节）。

### 3.1 登录与鉴权扩展点

本期仅管理员口令（bcrypt 哈希存库，会话为进程内 token，重启后需重新登录）。鉴权实现位于 `server/src/auth/authenticator.ts`（`AdminPasswordAuthenticator` + `SessionStore`），路由通过 `buildAuthRoutes(db, { loginRequired })` 注入；后续接入 OA/LDAP 只需新增一个 `Authenticator` 实现并替换注入，业务路由无需改动。

---

## 4. 通知渠道对接

通知在任务到达终态（成功 / 失败）后异步发送，失败重试 3 次（退避 500ms / 1500ms），最终结果写入通知日志（渠道、任务、原因），**不影响评审任务本身**。

### 4.1 邮件（SMTP）

在「通知配置 → 邮件渠道」填写：SMTP 主机、端口（587 / 465）、是否 TLS、发件人、收件人列表（多个用逗号分隔）、用户名与口令（口令加密存储，回显为 `********`）。保存后可点「发送测试」验证。

### 4.2 聊天机器人（通用 webhook）

适用于任意企业私有聊天软件：填写机器人 webhook 地址，可选自定义请求 header（如 `Authorization`），并编辑消息模板。占位符：

| 占位符 | 含义 |
| --- | --- |
| `{{repo}}` | 仓库名称 |
| `{{node}}` | SVN revision 或 Git commit sha |
| `{{author}}` | 上库人员 |
| `{{status}}` | 任务状态（成功 / 失败） |
| `{{summary}}` | 评审摘要（失败时为错误原因） |
| `{{report_url}}` | 报告链接（基于 `PUBLIC_BASE_URL`） |

模板有两种模式：

- **纯文本模板**：渲染后包一层默认信封 `{"text": "<渲染结果>"}`。
- **整包 JSON 模板**：模板以 `{` 或 `[` 开头时，渲染结果会被 `JSON.parse` 后原样作为请求体（校验失败会在发送时报错并写入通知日志）。

示例（常见私有平台的 markdown 结构）：

```json
{
  "msgtype": "markdown",
  "markdown": {
    "content": "**代码评审** {{repo}} {{node}} {{status}}\n> 上库人员：{{author}}\n> 摘要：{{summary}}\n> [查看报告]({{report_url}})"
  }
}
```

示例（纯文本）：

```
【代码评审】{{repo}} {{node}} {{status}}
上库人员：{{author}}
摘要：{{summary}}
报告：{{report_url}}
```

未配置模板时使用内置纯文本模板。保存后可点「发送测试」验证 webhook 可达。

---

## 5. 评审与监控行为说明

- **手动单节点**：SVN 输入 revision 号（必须存在），Git 输入完整或短 commit sha（短 sha 需唯一）。
- **手动区间**：SVN 输入 `from`/`to` revision（`to` 超出 HEAD 会自动截断到 HEAD），Git 输入起止 commit；区间内**逐节点**创建独立评审任务（旧 → 新）。已评审过的节点默认跳过，可带 `force` 重新评审。
- **自动监控**：首次启用时以当前 HEAD 为起点（可用「回溯 N 节点」补评最近 N 个）；之后按间隔增量轮询。人员白名单与路径前缀**同时配置时为 AND 语义**；未命中的节点写入"跳过"日志并记录原因；已评审节点不重复建任务。处理位置持久化，服务重启后从上次位置继续。
- **执行并发**：同一仓库串行（保护工作副本/克隆），不同仓库并行（默认 2 个）。
- **服务重启**：残留的 `running` 任务标记为 `failed`（原因 `service restarted`），`queued` 任务继续执行。

---

## 6. 评审引擎、MCP 服务器与项目记忆

### 6.1 评审引擎（可插拔）

- 首次启动自动注册一个默认 **ocr** 引擎并设为全局默认；「评审引擎」页可新增 / 启停 / 设默认 / 查看能力声明（支持的 VCS、MCP 接入方式、记忆注入方式等）。当前版本仅内置 ocr 适配器，claude-code / codex 等适配器为后续规划。
- **三级选择**：任务的引擎按 监控规则级 → 仓库级 → 全局默认 解析；解析失败（引擎被删除或停用）任务**直接失败并写明原因，不静默回退**。被历史任务引用的引擎只能停用、不能删除。
- **版本门控**：每次评审前探测 `ocr --version`，低于 **1.13** 的运行时自动跳过 MCP 注入与记忆注入（评审照常执行，任务详情标注降级原因）。
- **隔离模型**：在「仓库设置」中配置评审并发数（默认 2，设为 1 串行）和评审模型。每个运行中的任务独占一个完整工作副本、ocr HOME 和 CodeGraph 索引，副本按需创建并复用。模型可继承全局配置或指定仓库 Provider；单个任务调用一个模型。服务实例总并发同时受 `REVIEW_MAX_CONCURRENCY` 限制。

### 6.2 MCP 服务器

平台启动时默认注册 [CodeGraph](https://github.com/colbymchenry/codegraph)。Git / SVN 工作副本切到目标节点后，平台先初始化或同步本地索引，再向支持 MCP 的评审引擎提供 `codegraph_explore`。查询范围限定为当前任务的工作副本。索引失败会记录原因，本次评审继续执行。

CodeGraph 随 npm 生产依赖安装，macOS 和 Windows 免安装包包含对应平台的运行时。打包时请安装 npm 可选依赖。目标机器无需单独安装 CodeGraph，评审时也无需下载运行时。管理员可在「MCP 服务器」页停用 `codegraph`。

- **配置方式**（「MCP 服务器」页）：填写名称、传输类型与连接配置——
  - `stdio`：启动命令 + 参数（空格分隔）+ 可选环境变量（JSON），例如 `codegraph` + `serve --mcp`；
  - `http`：URL + 可选请求头（JSON，可放鉴权 token）。
- **作用域**：全局（所有仓库生效）或绑定单个仓库；评审时收集「全局启用 + 本仓库绑定启用」一并注入。
- **工具白名单**（可选）：ocr 引擎不支持按工具过滤，白名单会以「未强制执行」标注在任务审计中（引擎支持时会强制）。
- **连通性测试**：页内一键测试，stdio 完成 MCP initialize 握手并枚举 tools/list；http 按 Streamable HTTP 语义调用。测试展示工具清单，不改注册表。
- **审计**：每次评审的任务详情展示注入了哪些服务器、白名单是否强制、引擎上报的工具调用统计（引擎未上报时显式标注）。
- **脱敏**：headers / env 中的鉴权值在列表与详情接口回显为 `********`，完整值仅用于注入与测试。
- **⚠️ 风险提示**：MCP 服务器以平台服务账号的权限执行任意命令（stdio）或访问网络地址（http），**仅应添加可信来源的 MCP**；配置接口仅管理员可用。

### 6.3 项目记忆

按仓库沉淀可复用的评审知识，让同一工程的评审随使用次数增多而更准、更快。

- **六类记忆**：architecture（架构）/ convention（约定）/ pitfall（坑点）/ suppression（误报抑制）/ history（历史修复）/ glossary（术语）。
- **双存储**：SQLite（含 FTS5 trigram 全文索引，支持中文检索）为准；`data/memory/<repo-id>/` 下按类型组织的 markdown 为投影，可手工编辑后点「重载 markdown」生效。
- **评审前注入**：平台采集本次变更文件（svn / git diff），按作用范围前缀 + 全文检索召回，按 置信度 × 时间新近度 × 命中次数 排序，截断至 1500 token 预算，经 ocr `--requirement`（业务背景参数）注入；命中条目与计数在任务详情可见。仓库无记忆或引擎不支持时评审照常执行。
- **反馈闭环**：报告 issue 行尾「误报 / 已修复」——误报按指纹（文件前缀 + 类型 + 描述归一化）聚合进 suppression 记忆，同一模式每累计 3 次确认置信度 +0.1；已修复生成 history 记忆。
- **确定性抑制**：报告入库前按 suppression 指纹过滤，命中的 issue 默认不展示于报告与通知（报告详情可展开审计），不依赖引擎是否遵从注入提示。
- **记忆查询 MCP 桥**（内置 `memory.query` 服务器）：ocr ≥ 1.13 且引擎支持 MCP 时，评审 agent 可在循环中**按需查询**记忆（`memory_search` / `memory_get` / `memory_stats` 三个只读工具），例如"这个模块以前有什么已确认的误报"。桥以只读方式访问记忆库，仓库作用域由平台强制注入，无需配置；不想启用时在「MCP 服务器」页停用名为 `memory.query` 的记录即可。
- **评审后蒸馏**：评审成功后异步调用 LLM 提炼候选记忆（每次至多 5 条，与既有条目按标题归一化合并），失败仅记日志、不影响任务。
- **演化治理**：90 天未命中且低置信度的条目自动归档；每完成 20 次评审合并重复条目；「生成项目画像」按钮可对新仓库冷启动（扫描工作副本产出架构 / 约定基础记忆，可重复执行为更新）。
- **降级**：环境缺少 FTS5 / trigram 时全文检索自动降级为 LIKE（记忆页有提示）；置信度 < 0.3 的条目不参与召回。

---

## 7. 跨平台冒烟验证

`scripts/smoke.mjs` 会自建临时 SVN / Git 仓库、本地 webhook 接收器与本地 SMTP stub，驱动一个运行中的平台实例走完整流程（10 个阶段、43 项检查）：

1. 启动与依赖检查、首次设置口令、登录鉴权
2. LLM Provider 配置（可选）
3. 通知渠道（聊天 + 邮件）测试发送
4. 配置 SVN / Git 仓库
5. 手动单节点（SVN r2 / Git sha）与 SVN 区间评审
6. 报告读取
7. 通知投递（webhook + SMTP 均收到，且包含仓库名）
8. 自动监控（作者 + 路径过滤命中 / 跳过）
9. 触发规则（仅失败 / 仅成功）与失败通知
10. 服务重启恢复（可选，需由脚本托管服务进程）

```bash
# Linux（服务已另行启动）
BASE_URL=http://127.0.0.1:3000 node scripts/smoke.mjs

# 由脚本自己启动/重启服务（覆盖第 10 阶段）
SMOKE_SERVER_CMD="node server/dist/index.js" \
SMOKE_SERVER_CWD=/opt/codereview-hub \
SMOKE_DATA_DIR=/tmp/crp-smoke/data \
SMOKE_DIR=/tmp/crp-smoke/scratch \
BASE_URL=http://127.0.0.1:3996 \
node scripts/smoke.mjs
```

```powershell
# Windows
$env:PATH="D:\tools\svn-1.14.5\bin;$env:PATH"
$env:SMOKE_SERVER_CMD="node server/dist/index.js"
$env:SMOKE_SERVER_CWD="D:\code\codereview-hub"
$env:SMOKE_DATA_DIR="D:\tmp\crp-smoke\data"
$env:SMOKE_DIR="D:\tmp\crp-smoke\scratch"
$env:BASE_URL="http://127.0.0.1:3997"
node scripts/smoke.mjs
```

可选环境变量：`ADMIN_PASSWORD`（默认 `smoke-admin-123`）、`SMOKE_LLM_BASE` / `SMOKE_LLM_MODEL` / `SMOKE_LLM_KEY` / `SMOKE_LLM_PROTOCOL`（创建 Provider）、`SMOKE_TIMEOUT_MS`、`SMOKE_KEEP=1`（保留临时目录）。

已验证结果：Windows 与 WSL2 Ubuntu 均 **49/49 通过**（10 个阶段：启动检查、Provider、通知渠道、仓库、手动评审、报告、通知投递、自动监控、触发规则与失败通知、服务重启恢复）。

> 未配置 Provider 时 `ocr` 回退到运行账号的 `~/.opencodereview/config.json`；该文件不存在时评审会以
> `resolve LLM endpoint: no valid LLM endpoint configured` 失败。跨平台冒烟前请先确认运行账号下这份配置可用
> （或改用 `SMOKE_LLM_BASE` 创建 Provider）。

### WSL2 注意事项

- WSL 内无法访问 Windows 上绑定 `127.0.0.1` 的服务。若 LLM 端点在 Windows 主机上，可用 `scripts/tcp-forward.mjs` 转发到 `0.0.0.0`，再用 Windows 局域网 IP 访问：

  ```bash
  # Windows 侧
  node scripts/tcp-forward.mjs 3426 127.0.0.1:3425
  # WSL 侧
  SMOKE_LLM_BASE=http://<Windows 局域网 IP>:3426 ...
  ```

- 从 Windows 复制过来的 `node_modules` 含平台相关二进制（`@rollup/rollup-linux-x64-*`、`better-sqlite3`），在 WSL 中需重新安装：`rm -rf web/node_modules web/dist && npm ci && npm --prefix web ci && npm run build`。
- 用 `nohup ... &` 在独立的 `wsl -e bash -lc` 会话里启动服务会在该会话退出时被回收；冒烟时请用 `SMOKE_SERVER_CMD` 让脚本托管进程，或在同一个 shell 会话中启动并运行。

---

## 8. 开发

```bash
npm run dev        # 并行启动后端（tsx watch :3000）与前端（Vite :5173，/api 代理到 3000）
npm test           # Vitest（服务端单测 / 集成测试）
npm run lint       # ESLint（server/src、web/src）
npm run build      # 构建服务端与前端
```

目录结构：

```
server/src/
├── index.ts            # 启动：依赖检测 → DB → 引擎引导 → 队列 → 路由 → 静态 SPA
├── auth/               # 管理员口令鉴权（可替换接口层）
├── crypto/             # AES-256-GCM 凭据加密
├── db/                 # SQLite 迁移（v9：引擎/MCP/记忆）
├── deps/               # svn/git/ocr 探测与版本校验
├── engines/            # 可插拔评审引擎：类型、ocr 适配器、注册表、三级选择、任务执行器
├── mcp/                # MCP 注册表、注入器、连通性测试（stdio/http）
├── memory/             # 项目记忆：存储/检索/注入/反馈/蒸馏/演化/确定性抑制
├── monitor/            # 轮询、过滤、监控状态
├── notifications/      # 渠道配置、邮件/聊天适配器、发送器
├── providers/          # LLM Provider 配置与 ocr 隔离 HOME
├── repos/              # 仓库 CRUD 与连通性验证
├── tasks/              # 任务队列、ocr 进程管道、报告解析（含抑制）、手动触发
└── vcs/                # svn / git 命令封装
web/src/pages/          # 仓库 / 监控 / 触发 / 任务 / Provider / 引擎 / MCP / 记忆 / 通知 / 设置
scripts/smoke.mjs       # 跨平台端到端冒烟
openspec/               # 规格驱动开发：specs/ 主规格 + changes/ 历史变更
```

---

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| 启动日志显示 `ocr [MISSING]` | `npm i -g @smallfishworld/open-code-review-svn@1.13.8-svn.1`，确认 `ocr --version` 可用 |
| 启动日志显示 `ocr [BROKEN] 版本过低` | 升级到 >= 1.12.13 |
| 任务详情显示引擎降级（跳过 MCP / 记忆注入） | ocr < 1.13，升级后自动恢复注入 |
| `svn [BROKEN]` 或评审报 "is not a git repository or SVN working copy" | `svn --version` 需 >= 1.9（`--show-item` 支持）；Windows 上确认 PATH 中的 svn 不是 TortoiseSVN 的旧版本 |
| 任务失败且错误含 `LLM completion error` | Provider 地址 / Key / 模型不可用；在「LLM Provider」页点「测试连接」，或检查网络 |
| 任务失败且错误含「引擎 … 已停用 / 不存在」 | 「评审引擎」页恢复该引擎或调整 仓库 / 规则级引擎绑定；平台不静默回退到其他引擎 |
| MCP「连通性测试」报启动失败 / 超时 / 协议错误 | 启动失败：确认命令在本机可执行且参数正确；超时：调大该服务器的超时秒数；协议错误：确认目标是 MCP stdio 服务器（如 `codegraph serve --mcp`） |
| 任务详情 MCP 统计显示「引擎未上报工具统计」 | 当前 ocr 版本的 JSON 输出不含工具调用统计，属预期；注入清单仍然可查 |
| 项目记忆页提示 FTS 不可用 | 当前 better-sqlite3 环境缺少 FTS5/trigram，检索已降级为 LIKE（功能可用，仅召回质量略降） |
| 通知日志显示 `failed` | 查看日志中的原因（SMTP 认证失败、webhook 返回 HTTP 4xx/5xx 等）；用「发送测试」复现 |
| 重启后需重新登录 | 会话保存在内存中，属预期行为 |
