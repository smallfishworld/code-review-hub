# Proposal: pluggable-engines-mcp-memory

## Why

平台当前把 `ocr` 写死为唯一评审执行器：任务队列直接调用 `OcrRunner`，无法切换其他评审智能体；评审只靠 LLM 现场读工作副本文件，速度受限于逐文件读取，也无法复用任何历史评审积累。随着评审任务增多，同一个工程反复被从头评审，误报无法标记、踩过的坑无法沉淀，评审质量不随使用次数提升。

## What Changes

- **可插拔评审引擎**：新增 `ReviewEngine` 适配器接口（能力声明：支持的 VCS、revision 模式、全文件扫描、MCP 注入方式、记忆注入方式、resume、streaming），现有 ocr 调用逻辑迁移为 `OcrEngine` 适配器；任务队列按 `task.engine_id` 解析引擎，支持三级选择（全局默认 → 仓库级 → 规则级）；报告记录实际使用的引擎。
- **MCP 服务器注册表**：平台统一管理 MCP 服务器（stdio/http 传输、command/args/env 或 url/headers、启停、作用域 global/repo、工具白名单、超时），评审时注入引擎配置（ocr 走按仓库隔离的 HOME `config.json` 的 `mcp_servers.<name>` 字段，ocr ≥ 1.13 原生支持、低版本运行时自动降级跳过注入）；提供连通性测试（stdio/http 均 initialize → tools/list）与调用审计（注入清单落库持久化，工具统计在引擎上报时采集、未上报显式标注）；工具白名单按引擎能力尽力强制、无法强制时显式标注；敏感配置值回显脱敏；仅管理员可配置。
- **项目记忆**：按仓库维护六类记忆（architecture / convention / pitfall / suppression / history / glossary），SQLite `memory_entry` + FTS5（trigram，中日韩文本可用）索引为准、markdown 为投影（`<DATA_DIR>/memory/<repo-id>/`，支持人工编辑后重载）；平台自行采集变更文件列表（svn/git diff）作为检索输入，评审前按 scope 前缀 + FTS 检索、置信度×时间×命中排序、1500 token 预算（中英混合估算）注入引擎（ocr 经 `--requirement`）；评审后 LLM 蒸馏写入（每次限额 3–5 条、合并去重）；issue 级反馈闭环（误报 / 已修复按钮 → 按误报指纹聚合强化 suppression、生成 history 记忆）；报告入库前按 suppression 指纹做确定性抑制过滤（默认不展示、详情可审计，不依赖引擎遵从注入提示）；置信度增减、90 天未命中衰减、每 20 次评审 compaction、冷启动项目画像生成。
- **DB 迁移 v9**：新增 `engine`、`mcp_server`、`memory_entry`（含误报指纹、人工确认计数）、`memory_injection`、`review_feedback`（关联记忆条目）、`task_mcp_injection`（MCP 审计落库）表；`task` 增加 `engine_id`；`report` 增加 `engine`；`report_issue` 增加可空 `end_line` 与抑制标记列。
- **Web 控制台**：新增引擎管理页与 MCP 服务器页；仓库详情新增「项目记忆」tab；任务详情展示引擎、注入记忆条数、MCP 工具调用统计；报告 issue 增加误报 / 已修复反馈按钮。
- 分期实施：P1（引擎抽象 + ocr 迁移 + MCP 注册表与注入）→ P2（记忆 v1：suppression + convention + 反馈闭环）；claude-code 等第二引擎适配器与蒸馏/衰减/compaction 属 P3/P4，不在本 change 内强制完成，但接口与表结构需一次性预留。

## Capabilities

### New Capabilities

- `review-engine`: 可插拔评审引擎——引擎注册与能力声明、三级引擎选择、按引擎执行评审并归一化输出、报告的引擎归属记录；现有 ocr 行为迁移为首个适配器，对外行为不变。
- `mcp-integration`: MCP 服务器集成——服务器注册表 CRUD 与启停、作用域绑定、评审时注入引擎配置、连通性测试、调用审计与管理员权限边界。
- `project-memory`: 项目记忆——记忆条目模型与六类记忆、markdown+SQLite 双存储、评审前检索注入、评审后蒸馏写入、issue 反馈闭环、置信度与衰减演化、项目画像。

### Modified Capabilities

（无——项目尚无已同步的主 specs；现有评审行为随 `review-engine` capability 一并声明。）

## Impact

- **代码**：`server/src/tasks/`（ocrRunner 拆入新 `server/src/engines/` 适配器层、taskQueue/taskRoutes/triggerService 增加引擎选择）、`server/src/mcp/`（新）、`server/src/memory/`（新）、`server/src/db/database.ts`（v9 迁移）、`server/src/tasks/reportService.ts`（engine 归属 + 反馈）、`web/src/pages/`（新引擎页 / MCP 页 / 记忆 tab / 任务详情增强）、`web/src/api/client.ts`。
- **API**：新增 `/api/engines`、`/api/mcp-servers`、`/api/repos/:id/memory`、`/api/tasks/:id/feedback` 等路由；现有路由行为不变。
- **依赖**：无新增运行时依赖（FTS5 由 better-sqlite3 内置支持）。
- **兼容**：现有任务 / 报告数据不受影响（迁移 v9 全部为新增表 + 可空列）；未配置引擎时行为等同现状（默认 ocr 引擎）。
- **风险面**：MCP 服务器配置 = 任意命令执行，必须管理员权限 + 审计，注入配置按仓库隔离防并发泄漏；记忆注入有 token 预算上限，防止 prompt 膨胀；确定性抑制只标记不删除，可回溯审计。
