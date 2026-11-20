# Design

## Context

2026-11-20 本机端到端实测（本地 svnadmin 仓库 + 真实 ocr 1.13.8-svn.1 + mock agent LLM，见 commit dfbd473）确认：

1. ocr 是 agent 循环：anthropic messages + tools；注入的 MCP 服务器（codegraph）被真实启动、工具（codegraph_explore）暴露给模型并被真实执行，tool_result 流回对话。
2. ocr 的 `mcp_servers.<name>` Go 结构：`env` 为 []string（"KEY=VALUE"），`args` 为 []string，`headers` 为 object，http 带 `type`。
3. 平台侧注入器（`mcp/injector.ts`）已能按 引擎能力 + 降级状态 收集服务器并写入按仓库隔离的 `ocr-home/<repo-id>/config.json`；审计表 `task_mcp_injection` 含 server 快照与 ocr 上报的 tool_stats。
4. 记忆检索（`memory/retrieval.ts`）：scope 前缀 ∪ FTS5 trigram（LIKE 降级）→ confidence × recency(90d 半衰) × log2(2+hits)，1500 token 预算，confidence ≥ 0.3 门槛。

## Goals / Non-Goals

**Goals:**
- 评审 agent 可按需查询项目记忆（搜索/取详情/看统计），弥补预注入截断的盲区
- 零配置：符合条件的任务自动获得 `memory.query` 工具；显式停用只需注册表一条记录
- 只读 + 单仓库强制隔离；桥故障不影响评审任务
- 复用现有检索逻辑与审计表，无新增运行时依赖

**Non-Goals:**
- 不提供任何写工具（写入只走蒸馏/反馈治理管线）
- 不做语义向量检索（RRF 混合召回留待后续 change）
- 不做跨仓库查询（工具参数不含 repo 标识）
- 不改造预注入通道（1500 token `--background-file` 保留不变）

## Decisions

### D1. 形态：stdio 桥进程，只读 SQLite

桥为独立可执行入口 `dist/memory-mcp-bridge.cjs`（TS 源 `server/src/memory/mcpBridge.ts`，与平台同 tsconfig 编译、复用 `MemoryStore` / `MemoryRetrieval`）。ocr 按现有 MCP stdio 语义启动它（与 codegraph 同路径，已实测可行）。

- 桥启动时 `new Database(dbPath, { readonly: true, fileMustExist: true })`——WAL 下多进程只读并发安全；`busy_timeout=3000`。
- **不走平台 HTTP API**：避免鉴权/token/网络面；只读连接天然无写锁竞争。
- 配置仅经 env：`CRP_DATA_DIR`（定位 `app.db`）、`CRP_REPO_ID`（唯一作用域）。两者由注入器写入，**工具参数不含 repo 标识**，SQL 层强制 `WHERE repo_id = ?`——跨仓库读在结构上不可达。

- 备选：平台开 MCP streamable-http 端点 + token——放弃：多一个网络与鉴权面，且 ocr 对 http MCP 的实测覆盖不如 stdio（已验证 stdio 全链路）。
- 备选：桥内嵌向量语义检索——放弃（Non-Goal），FTS trigram 先行。

### D2. 工具面：三个只读工具

| 工具 | 入参 | 行为 |
| --- | --- | --- |
| `memory_search` | `query`(必), `kind?`(六类枚举), `limit?`(默认 5，上限 10) | FTS MATCH（逐串双引号包裹）+ 可选 kind 过滤 → 复用 `MemoryRetrieval` 排序（confidence × recency × hits）→ 返回 `[{id,kind,title,body,scope,confidence,hits,updatedAt,sourceTaskId}]` |
| `memory_get` | `id`(必) | 单条全文 + 来源任务 id（`WHERE repo_id = ? AND id = ?`，跨仓库 id 直接 miss） |
| `memory_stats` | 无 | `{active, archived, byKind: {kind: n}, ftsAvailable, lastReviewCount}` ——模型据此决定是否继续查询 |

输出为 MCP text content，JSON 序列化；空结果返回明确文案（"该仓库无匹配记忆"）而非空串。

- 检索口径与预注入一致（同一 `MemoryRetrieval`），但 `memory_search` **不做 scope 前缀限制**（agent 可跨 scope 查询；scope 作为返回字段帮助模型判断适用性）；confidence ≥ 0.3 门槛保留。
- suppression 条目可查（body 是人工写的误报原因，正是深挖需求），fingerprint 字段不返回（内部实现细节）。

### D3. 内置自动附加与显式停用

注入器收集生效服务器后，满足以下全部条件时自动追加内置条目 `memory.query`：

1. 任务引擎 `capabilities.memoryInjection !== 'none'`；
2. 引擎 MCP 能力为 `config-inject` 且未被降级（与用户注册服务器同一门控）；
3. 注册表中**不存在同名 `memory.query` 记录**（自动附加），或存在且 `enabled=1`（用户显式启停优先）。即：用户想关闭，创建一条同名停用记录即可。

内置条目格式（写 `config.json` 的 `mcp_servers.memory.query`）：

```json
{ "command": "node", "args": ["<dist 绝对路径>/memory-mcp-bridge.cjs"], "env": ["CRP_DATA_DIR=<dataDir>", "CRP_REPO_ID=<repoId>"], "enabled": true }
```

- 桥脚本绝对路径在运行时由注入器模块自身位置推导（`fileURLToPath(import.meta.url)` 同级）——跨平台（POSIX/Windows）一致，Windows 下 `node` 由 CreateProcess PATH 解析。
- 审计：内置条目与其他服务器同样写入 `task_mcp_injection`（server_name = `memory.query`，allowlist_enforced = 1）；ocr 上报的 tool_stats 照常落库。

- 备选：作为普通注册表项由用户手动注册——放弃：违反"零配置"目标，且用户可能误配跨仓库 env。
- 备选：桥常驻平台进程内（in-process MCP）——放弃：ocr 按服务器粒度启停 stdio 子进程，桥进程生命周期对齐评审进程，崩溃隔离更干净。

### D4. MCP 协议实现

桥实现最小 stdio JSON-RPC 子集（换行分帧）：`initialize` → `tools/list` → `tools/call`；`notifications/initialized` 幂等忽略。工具 schema 与 codegraph 同风格（input_schema JSON Schema）。协议细节以已实测的 codegraph 交互为准（ocr 侧已验证该分帧与应答形态）。

### D5. 故障与降级

- SQLite 文件缺失/锁超时 → 工具返回 `isError=false` + 明确文案（"记忆库暂不可用"），桥不退出——ocr 的 MCP 循环对工具报错的容忍已在 codegraph 场景实测（"No CodeGraph project loaded" 不影响评审）。
- 桥进程崩溃 → ocr 的 MCP 客户端按既有行为降级（评审继续，工具不可用），任务不受影响。
- 未配置记忆 / 仓库无条目 → `memory_search` 返回空文案；`memory_stats` 返回零统计。

## Risks / Trade-offs

- [只读连接仍可能持有 WAL 读快照导致 db 膨胀] → 桥随评审进程退出即释放；WAL checkpoint 由平台主进程周期执行（已有 WAL 模式），监控点加入 README。
- [agent 过度查询拖慢评审] → `--max-tools`（ocr 已有，默认模板值）约束轮次；工具输出截断（limit ≤ 10、单条 body 截 2000 字符）。
- [内置服务器与用户注册同名冲突] → D3 规则：用户记录优先（可停用内置），文档写明。
- [Linux 文件锁差异] → better-sqlite3 readonly + busy_timeout，WAL 读不阻塞写；跨平台已在 smoke 覆盖范围。

## Migration Plan

1. 桥入口与工具实现先行（含单测：内存库 + 临时库覆盖三工具、repo 隔离、中文查询）。
2. 注入器自动附加（含单测：附加条件、显式停用、env 内容、审计行）。
3. 端到端：复用 2026-11-20 实测环境（本地 svn + 真实 ocr 1.13.8 + mock agent LLM），在 mock 的工具调用序列中加入 `memory_search` 阶段，断言 tool_result 含真实记忆文本；`task_mcp_injection` 出现 `memory.query`。
4. 回滚：移除内置附加逻辑即可（注册表与记忆数据无 schema 变化）。

## Open Questions

1. ocr 对工具输出长度是否有上限裁剪（实测 codegraph 输出约 13–24K 字符正常返回）——按 D2 的输出截断设计先行，端到端实测后再调。
2. `memory_search` 是否需要暴露 suppression 的 `feedback_count` 以便模型判断抑制可信度——首版返回 confidence 即可，实测后评估。
