# Design

## Context

全新项目（仓库目前只有 `openspec/`）。核心是对已有 CLI 工具 `ocr`（[@smallfishworld/open-code-review-svn](https://github.com/smallfishworld/open-code-review-svn)）的服务化封装：上游支持 Git 提交/区间评审，SVN fork 支持工作副本/单 revision/revision 区间评审，均支持 `--format json --output <file>` 结构化输出。平台自身不调用 LLM、不解析 diff——这两件事都交给 `ocr`。平台需同时支持 SVN 与 Git 两类仓库，跑在 Linux 和 Windows 上（团队环境两者皆有），因此技术选型必须跨平台且进程调用不能依赖平台 shell 特性。通知面向企业私有部署的聊天软件（具体平台不定，按通用 webhook 设计）。

## Goals / Non-Goals

**Goals:**
- 单一服务进程：HTTP API + Web 前端 + 任务执行器 + 仓库轮询监控器（SVN/Git 两套探测逻辑，共用过滤与建任务路径）+ 通知发送器。
- 所有状态（仓库/凭据/Provider/监控规则/任务/报告/通知渠道与日志）持久化，重启可恢复。
- 与 `ocr` 的边界清晰：平台只负责编排（何时评审哪个节点），评审质量与 LLM 交互完全交给 `ocr`。
- 跨平台：Windows/Linux 同一套代码与命令。
- 通知渠道对任意私有聊天软件可接入：通用 webhook + 可配置模板，不做特定平台 SDK 绑定。

**Non-Goals:**
- 不修改、不内嵌 `ocr` 源码；通过 CLI 子进程集成，便于跟随上游升级。
- 不做统一登录接入（OA/LDAP）——本期仅管理员口令，但鉴权层留扩展点（见 D6）。
- 不做多租户/复杂权限体系。
- 不做逐用户订阅偏好（本期通知规则全局统一，不做"每人只收自己代码的通知"）。
- 不支持跳过节点的"区间合并评审"——区间内逐节点独立评审（与需求一致）。

## Decisions

### D1. 技术栈：Node.js + TypeScript + Fastify + React（Vite）+ SQLite

- **理由**：
  - `ocr` 是 npm 生态的工具，Node 运行时与其亲和；Linux/Windows 行为一致，`child_process.spawn` 跨平台成熟。
  - SQLite（`better-sqlite3`）单文件数据库，零运维，适合单机部署；任务/报告数据量（每节点一条 JSON）远不构成规模压力。
  - Fastify 轻量、内置 JSON schema 校验；React + Vite 是团队可维护的主流选择。
- **备选**：
  - Go：进程管理强，但团队后续要改前端/写规则，TS 全栈一处搞定更省；且 `ocr` provider 配置生态偏 JS。
  - Java/Spring：部署重，跨平台脚本化不如 Node 简单。
  - Postgres：对单机内网工具是过度设计。

### D2. `ocr` 集成方式：子进程 + 文件级 JSON 输出

- SVN 任务执行 `ocr review --repo <wc> --commit <rev> --format json --output <report.json>`；Git 任务执行 `ocr review --repo <git-repo> --commit <sha>`（区间 `--from/--to` 拆分见 D4）。
- 工作副本/克隆策略：**每个仓库维护一个本地缓存**——SVN 为 `svn update -r <rev>` 的工作副本，Git 为 `git fetch + checkout <sha>` 的裸/工作克隆（`ocr` 需要 `--repo` 指向本地路径，且其 agent 的 `file_read`/`code_search` 依赖本地文件）。监控轮询时顺带同步到最新。
- **备选**：无本地副本、纯远端操作——`ocr` 要求 `--repo` 为本地路径，故不可行。
- **注意**：`ocr` 不支持 SVN 历史评审的 `--resume`，任务失败即整体失败，不做断点续传。

### D3. 任务模型：持久化任务表 + 进程内队列

- 任务表字段：`id, repo_id, node(SVN revision 或 Git commit sha), trigger(manual|auto), status(queued|running|succeeded|failed|cancelled), author, error, ocr_exit_code, started_at, finished_at, report_id`。
- 执行器为进程内 async worker pool：**按仓库串行（同一仓库同一时刻只跑一个任务，保护工作副本/克隆）、跨仓库并行**；并发仓库数为可配置项。
- 崩溃恢复：服务启动时把残留的 `running` 任务标记为 `failed`（原因 "service restarted"）；`queued` 任务重新入队。
- **备选**：Redis/BullMQ 队列——引入第二个进程和中间件，对单机工具不值得。

### D4. 区间评审 = 拆分为多个单节点任务

- SVN 区间用 `svn log` 拿每个 revision 的作者与变更路径；Git 区间用 `git log --reverse <from>..<to>` 拿每个 commit 的作者与变更文件。然后逐节点建任务（复用单节点评审路径与去重逻辑）。
- **理由**：与需求"多个节点评审、每个节点独立报告"天然吻合；监控触发的也是单节点，两条路径合一；SVN 与 Git 共用同一套"枚举节点→过滤→建任务"管线。

### D5. 监控：增量轮询 + 过滤器在平台侧实现

- **SVN**：每仓库一个 timer，`svn log --xml -r (last+1):HEAD` 增量识别；**Git**：`git fetch` 后对比 `origin/<branch>` 与已处理位置（`git log --reverse <last>..<origin/branch>`）。逐节点取 author 与变更路径，应用人员白名单（AND 语义：同时配置时需都满足）与路径前缀过滤，命中则建任务。
- **初始起点**：监控规则首次启用时默认以当前 HEAD/最新 commit 为起点（避免回溯评审整个仓库历史），可选配置回溯最近 N 个节点。处理位置持久化在监控状态表；轮询幂等 + 任务表去重检查兜底。
- **备选**：SVN post-commit / Git server-side hooks——要求在服务器上装 hook，部署受限；轮询只要求客户端网络可达，符合"部署在 Linux 或 Windows 上"的约束。hook 可作为未来优化。

### D6. 凭据、鉴权与扩展点

- SVN/Git/LLM/SMTP/聊天机器人凭据统一用本机密钥加密（AES-256-GCM，密钥来自首次启动生成的本地 keyfile，权限限制为当前用户；内网单机工具的威胁模型下够用），界面回显不展示明文。
- 服务默认只监听内网地址；**本期鉴权 = 管理员口令（bcrypt 哈希存库）**，可配置关闭。鉴权实现为可替换的接口层（`authenticator` + session 签发），后续接 OA/LDAP 只新增一个实现，不动业务路由。

### D7. 报告存储

- `ocr` 的 JSON 原文存文件（`data/reports/<task-id>.json`），数据库存索引与解析后的问题摘要（文件/行号/级别/描述），列表页查询走数据库，详情页读取原文。
- **理由**：列表检索要快且可过滤；原文留档便于 `ocr` 升级后格式变化时不丢数据。

### D8. 通知子系统：任务完成钩子 + 通用渠道抽象

- 任务到达终态（succeeded/failed）后由 worker 发出完成事件，通知器**异步**消费（不阻塞任务队列）。
- 渠道抽象为统一接口：`render(template, context) → payload` + `send(payload)`。本期实现两个渠道：
  - **邮件**：nodemailer（SMTP 配置加密存储，收件人列表全局配置）。
  - **聊天机器人**：`fetch` POST 到企业私有聊天软件的机器人 webhook URL（可带自定义 header 凭据），消息体由**用户可配置模板**渲染，支持占位符 `{{repo}} {{node}} {{author}} {{status}} {{summary}} {{report_url}}`；未配置时用内置纯文本默认模板。因各企业聊天平台 webhook 格式各异（有的要 `{"text": ...}`、有的要 markdown 结构），模板同时支持"整包 JSON 模板"（直接渲染完整请求体，占位符替换后 JSON.parse 校验）与"纯文本模板"（包一层默认信封）。
- 触发规则全局统一：全部完成 / 仅失败 / 仅成功。发送失败有限重试（如 3 次退避），仍失败则写通知日志（渠道、任务、原因），**不影响任务状态**。
- **备选**：钉钉/飞书/企微专属 SDK——用户明确是企业私有软件、平台不定，绑 SDK 反而不可移植；通用 webhook + 整包模板可对接任何私有平台。

## Risks / Trade-offs

- [ocr 单节点评审依赖本地工作副本/克隆，并发同步冲突] → 每仓库串行执行，跨仓库并行；配置项留扩展。
- [ocr 版本升级 JSON 格式变化] → 解析层做 schema 版本探测，解析失败时保留原文并把任务标记 succeeded-but-raw；pin 住已验证的 npm 版本。
- [轮询有延迟（间隔期内的新节点不会即时评审）] → 间隔可配（默认 5 分钟），文档说明；未来可加 post-commit/push hook 即时触发。
- [仓库凭据失效/网络抖动导致轮询或评审失败] → 失败记录进监控日志，下轮自动重试轮询；任务失败保留原因供手动重跑。
- [Git fetch 大仓库首次克隆耗时/磁盘占用] → 首次启用监控时后台执行初始克隆并显示进度；克隆未完成前该仓库监控标记"初始化中"。
- [企业聊天软件 webhook 格式未知/多样] → 整包 JSON 模板 + 测试发送按钮，管理员可现场调试；发送失败原因写入通知日志。
- [出网受限环境 SMTP/webhook 不可达] → 通知发送完全异步、失败隔离并记录日志，不影响评审主流程。
- [better-sqlite3 是原生模块，Windows 编译/预编译二进制偶有坑] → 使用 prebuilt binaries；必要时退路是 `node:sqlite`（Node 22+ 内置）。
- [区间内大量节点手动触发会瞬间建很多任务] → 区间触发前预估数量并提示确认（> 阈值时）。

## Migration Plan

全新部署，无迁移。发布流程：`npm ci` → 启动检测依赖（svn/git/ocr）→ Web 配置仓库/Provider/通知渠道 → 启用监控。回滚即停新版进程、用旧版代码启动（数据在 SQLite/文件中，向后兼容字段只增不改）。

## Open Questions

（无——登录方式与通知渠道已由用户确认；聊天机器人按通用 webhook 设计，具体企业平台的模板在部署时由管理员配置。）
