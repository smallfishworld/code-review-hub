# Proposal: memory-mcp-bridge

## Why

当前项目记忆只在**评审前一次性注入**（1500 token 预算的静态文本，经 ocr `--background-file`）。实测（2026-11-20，本机 svn + 真实 ocr 1.13.8 + mock agent LLM）证明 ocr 是 **agent 循环**：它把注入的 MCP 服务器工具（codegraph_explore）暴露给模型并真实执行。这意味着记忆可以更进一步——把「记忆查询」也做成 MCP 工具，让评审模型在 agent 循环中**按需主动查询**（"这个模块以前有什么误报"、"这条 suppression 的完整原因"），而不是只依赖预注入的截断文本。

## What Changes

- **记忆查询 MCP 桥**：新增 stdio MCP 桥进程（`memory-mcp-bridge.cjs`），以 **只读** 方式直接打开平台 SQLite（WAL 多进程读安全），复用现有 `MemoryRetrieval` 检索逻辑，对外暴露三个工具：
  - `memory_search { query, kind?, limit? }` — FTS + scope 召回，按置信度×新近度×命中排序
  - `memory_get { id }` — 单条全文（含来源任务链接）
  - `memory_stats {}` — 该仓库记忆统计（模型决定是否深查）
- **内置自动附加**：注入器在 引擎支持记忆注入 + ocr MCP 可用 时自动向任务注入名为 `memory.query` 的内置服务器（无需用户配置）；`mcp_servers` 注册表中创建同名**停用**记录可显式关闭。桥的配置经 env 传递（`CRP_DATA_DIR`、`CRP_REPO_ID`），工具参数不含 repo 标识——**强制单仓库作用域，杜绝跨仓库读**。
- **刻意只读**：不提供任何写工具。写入只走蒸馏 / 反馈两条治理管线（置信度、指纹聚合、审计都在那条路上）；LLM 直接写记忆会绕过治理，属已知"记忆污染"风险面。
- **与预注入互补**：`--background-file` 预注入保留（快速全局上下文），MCP 查询负责按需深挖；`task_mcp_injection` 审计天然覆盖桥的工具调用统计。
- **不做语义向量检索**：FTS5 trigram 已满足当前召回；RRF 混合检索（参考 sqlite-memory-mcp）留待后续 change。

## Capabilities

### MODIFIED Capabilities

- `project-memory`：新增「记忆查询 MCP 桥」需求——只读工具面、repo 隔离、降级行为。
- `mcp-integration`：新增「内置记忆查询桥的自动附加」需求——附加条件、显式停用、审计归属。

## Impact

- **代码**：`server/src/memory/mcpBridge.ts`（新，stdio JSON-RPC 最小实现：initialize / tools/list / tools/call）、`server/src/index.ts`（新增桥入口产物 `memory-mcp-bridge.cjs`）、`server/src/mcp/injector.ts`（内置服务器自动附加 + env 注入）、`server/tsconfig.json`（多入口）
- **依赖**：无新增运行时依赖（桥用 better-sqlite3 readonly + node 内置模块）
- **风险面**：桥为只读 SQLite 连接，无 HTTP、无凭据；仓库隔离由 env 强制；桥故障只表现为工具报错，不影响评审任务（与 codegraph "项目未索引" 同类降级）
- **兼容**：不开通时行为与现状完全一致（零回归）；审计沿用 `task_mcp_injection`

## 参考实现（调研结论）

- [doobidoo/mcp-memory-service](https://github.com/doobidoo/mcp-memory-service)：MCP 与 REST 共用同一记忆底座、记忆衰减 + 自动 consolidation——印证"同一存储、多服务形态"
- mem0 [OpenMemory MCP](https://mem0.ai/openmemory-mcp)：`search_memory` 极简工具面 + namespace 隔离
- 官方参考实现 `@modelcontextprotocol/server-memory`：`search_nodes` / `open_nodes` 只读/写分离的规范契约
- [pavex/mcp-memory-sqlite](https://mcpmarket.com/server/markdown-memory) / sqlite-memory-mcp：同底座（SQLite FTS5）；RRF 混合检索为后续方向
