# Tasks

## 1. 桥进程与工具实现（核心）

- [ ] 1.1 `server/src/memory/mcpBridge.ts`：stdio JSON-RPC 最小 MCP（initialize / tools/list / tools/call / notifications 忽略），只读 SQLite（readonly + fileMustExist + busy_timeout 3000），env 配置（CRP_DATA_DIR / CRP_REPO_ID）。验证：单测以内存库直驱工具函数断言 initialize 应答与 tools 清单
- [ ] 1.2 三个只读工具：`memory_search`（FTS 逐串双引号包裹 + kind 过滤 + limit ≤ 10 + 复用 MemoryRetrieval 排序）、`memory_get`（强制 repo_id 等值）、`memory_stats`（统计 + ftsAvailable）。输出 JSON text content，body 截 2000 字符；库缺失/锁超时返回明确文案不崩溃。验证：单测覆盖中文查询命中、跨仓库 id 不可达、空库文案、异常路径
- [ ] 1.3 多入口构建：`server/tsconfig.json` 增加 `memory-mcp-bridge.cjs` 入口产物，`npm run build:server` 产出桥脚本；注入器可推导其绝对路径。验证：构建产物存在且 `node dist/memory-mcp-bridge.cjs` 可启动（无 env 时输出提示退出）

## 2. 注入器内置自动附加

- [ ] 2.1 `mcp/injector.ts`：满足 引擎记忆能力 ≠ none + MCP config-inject 未降级 + 注册表无同名 enabled=false 记录 时，自动追加 `memory.query`（node + 桥绝对路径 + env CRP_DATA_DIR/CRP_REPO_ID）；用户同名记录存在时以其 enabled 为准。验证：单测覆盖自动附加、显式停用、降级跳过、env 内容断言
- [ ] 2.2 审计归属：内置条目写入 `task_mcp_injection`（server_name=memory.query，allowlist_enforced=1），与用户服务器并存。验证：单测断言混合注入（codegraph + memory.query）两行审计

## 3. 端到端实测（真实 ocr + agent mock）

- [ ] 3.1 复用 2026-11-20 实测环境（本地 svn 仓库 + 真实 ocr 1.13.8 + mock agent LLM）：mock 工具序列加入 `memory_search`（查 suppression）阶段，断言 tool_result 含真实记忆文本；`task_mcp_injection` 含 memory.query 且 ocr tool_stats 落库。验证：端到端输出记录到测试说明
- [ ] 3.2 降级路径实测：停用 memory.query 注册表记录后重评，确认注入消失且评审正常。验证：任务详情 MCP 审计无 memory.query

## 4. 集成回归与文档

- [ ] 4.1 全量回归：`npm test`、`npm run lint`、`npm run build` 通过；既有 smoke 阶段不受影响。验证：全绿
- [ ] 4.2 README 6.3 节补「记忆查询 MCP 桥」段落（自动附加条件、三个只读工具、显式停用方式）；MCP 页风险提示提及内置桥。验证：文档与行为一致
- [ ] 4.3 提交前以 `mimosa audit` 复核（policy 下应保持 0 高危）。验证：0 高危

## Workflow follow-up

- 实现完成后评审 spec 场景覆盖，执行 `openspec archive memory-mcp-bridge` 归档并同步主 specs
