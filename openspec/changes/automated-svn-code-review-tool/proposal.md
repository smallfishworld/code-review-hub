# Proposal

## Why

团队代码通过 SVN 与 Git 上库，缺少自动化评审环节。已有的开源 CLI 工具 [open-code-review-svn](https://github.com/smallfishworld/open-code-review-svn)（`ocr` 命令，上游支持 Git，fork 支持 SVN）已能对 Git 提交、SVN 工作副本/单个版本（revision）/版本区间做 AI 代码评审，但它是纯命令行工具：每次评审需要人工执行命令、无法持续监控新增上库节点、没有集中的评审结果留存，也没有配置界面。我们需要一个可部署在 Linux/Windows 上的服务化平台，让评审可以手动触发，也可以在新代码上库时自动触发，并在评审完成后主动通知相关人。

## What Changes

- 新建一个 Web 服务化平台（全新项目），封装 `ocr` CLI，支持 **SVN 与 Git 两类仓库**，提供：
  - **手动评审**：对指定的单个上库节点（SVN revision 或 Git commit）或一段节点区间发起评审。
  - **自动监控评审**：定时轮询一个或多个仓库的上库情况（SVN HEAD revision / Git 分支远端提交），发现新增节点后自动触发评审；支持过滤器——只评审指定上库人员提交的节点，或只评审涉及指定文件夹/文件的提交，两者可组合。
  - **Web 配置界面**：浏览器中完成所有配置与操作——仓库（SVN/Git）地址/凭据、`ocr` 的 LLM Provider 配置、监控规则（轮询间隔、人员过滤、路径过滤）、手动触发、评审任务进度与历史结果查看。
  - **评审结果通知**：评审完成后通过邮件和企业私有聊天软件的聊天机器人（webhook）发送通知，通知触发条件可配置（成功/失败/仅失败），消息内容含仓库、节点、作者、问题摘要与报告链接。
  - **评审结果留存**：评审任务与报告（含 `ocr --format json` 输出）持久化存储，可随时回看。
  - **跨平台部署**：同一套代码可在 Linux 和 Windows 上运行（Node.js 运行时 + 系统依赖 `svn`、`git`、`ocr` CLI）。
- 登录方式：仅管理员口令保护（凭据加密存储），鉴权层预留统一登录（OA/LDAP）扩展点，本期不接入。
- 不修改 `ocr` 本身：平台以子进程方式调用 `ocr review ...`，通过其 JSON 输出采集结果。

## Capabilities

### New Capabilities

- `review-execution`: 执行代码评审的核心能力——通过调用 `ocr` CLI 对指定的 SVN revision/revision 区间、Git commit/commit 区间发起评审，管理任务生命周期（排队、运行、成功、失败、取消），并持久化评审报告。
- `revision-monitoring`: 自动监控仓库新增上库节点的能力——轮询 SVN HEAD revision 或 Git 分支远端提交、识别新节点、应用过滤规则（上库人员、路径），命中后自动创建评审任务，并保证不重复评审、断线/重启后可恢复。
- `notifications`: 评审结果通知能力——评审任务完成后通过邮件与企业私有聊天机器人（webhook）渠道发送通知，渠道与触发规则可配置，通知发送失败不影响评审任务本身。
- `web-console`: 浏览器端配置与操作能力——SVN/Git 仓库与凭据管理、LLM Provider 配置、监控规则管理、通知渠道管理、手动触发评审、查看任务进度与历史报告。
- `platform-runtime`: 平台的部署与运行能力——配置持久化、跨平台（Linux/Windows）运行、服务启动方式、对 `svn`、`git` 与 `ocr` 依赖的检测（依赖按所用仓库类型条件要求）。

### Modified Capabilities

（无——全新项目，`openspec/specs` 目前为空。）

## Impact

- **新项目**：`openspec/` 之外的所有代码均为新增。预计包含 Web 服务（HTTP API + 前端页面）、任务执行器（子进程调用 `ocr`）、SVN/Git 轮询监控器、通知发送器、本地数据库（如 SQLite）。
- **外部依赖**：
  - `ocr` CLI：`@smallfishworld/open-code-review-svn`（npm 包或离线二进制），平台通过 `ocr review ... --format json --output <file>` 等命令调用（SVN 模式来自 fork，Git 模式继承上游）。
  - SVN 命令行客户端（`svn` ≥ 1.9，使用 SVN 仓库时需要）：用于仓库连通性验证与轮询。
  - Git（`git` ≥ 2.41，使用 Git 仓库时需要）：用于 clone/fetch 与分支轮询。
  - 一个可达的 LLM API 端点（由 `ocr` 的 provider 配置使用，平台只转发配置，不直接调用模型）。
  - 出网通知：SMTP 服务器（邮件渠道）、企业私有聊天软件的机器人 webhook 地址（聊天渠道），均为内网/私有部署地址。
- **部署环境**：Linux 与 Windows；需可访问 SVN/Git 仓库（网络可达 + 凭据）；服务需要文件系统写入权限（评审报告、数据库、仓库工作副本缓存）。
