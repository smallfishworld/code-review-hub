# Design

## Context

现有实现中评审执行逻辑集中在 `server/src/tasks/ocrRunner.ts`（构建 ocr 命令行、隔离 HOME、env 注入、解析输出），由 `taskQueue.ts` 直接调用；LLM Provider 经 `providers/ocrProviderConfig.ts` 生成隔离 `~/.opencodereview/config.json`（含 `language` 字段强制中文）。DB 迁移至 v8（`report_issue` 已有 `category` 列）。ocr ≥ 1.13 原生支持 `config.json` 的 `mcp_servers.<name>.<command|args|env|url|headers|enabled|type>` 配置与 `--requirement` 业务背景参数（均已从二进制验证）。better-sqlite3 内置 FTS5。

## Goals / Non-Goals

**Goals:**
- 引擎可替换：taskQueue 只依赖 `ReviewEngine` 接口，ocr 成为第一个适配器，行为零回归
- MCP 注册表 + 注入（ocr 走 config-inject），含测试与审计
- 项目记忆最小闭环：检索注入 + 反馈（误报/已修复）+ 蒸馏写入 + 演化治理
- P1/P2 可独立上线；接口与表结构对 P3/P4 一次预留

**Non-Goals:**
- 本期不实现 claude-code / codex / custom-http / custom-script 适配器（仅接口预留）
- 不做平台侧 MCP 客户端（平台自己调 MCP 工具做去重/影响面分析）
- 不做 embedding 向量检索（FTS5 关键词召回已满足初版）
- 不做多租户 / 非管理员可见性分级（沿用现有单一管理员模型）

## Decisions

### D1. 引擎接口与目录结构

新增 `server/src/engines/`：`types.ts`（`ReviewEngine`、`EngineCapabilities`、`NormalizedIssue`、`EngineContext/ReviewRequest/EngineRawResult`）、`registry.ts`（按 DB 记录实例化适配器）、`ocrEngine.ts`（现 ocrRunner 逻辑迁入）。`providers/ocrProviderConfig.ts` 保持原位（引擎复用）。

- 接口签名：`probe(cfg)`（依赖校验）、`prepare(ctx)`（工作副本）、`review(req, ctx)`（执行，返回原始输出 + usage + sessionId）、`normalize(raw)`（统一 issue 模型）。
- 能力声明为静态常量（编译期），DB 不存能力——能力属于适配器代码而非用户配置，避免配置与代码不一致。
- 备选：把能力存 DB 由用户改——放弃，能力错了会导致任务必败。

### D2. 三级引擎选择

解析顺序：监控规则 `engine_id` → 仓库 `engine_id` → 全局默认（`setting.default_engine_id`，兼取第一条 enabled 记录兜底）。解析结果落 `task.engine_id`；解析失败（引擎不存在/停用）任务直接失败并在 `error` 中写明。手动触发不新增引擎下拉（v1），跟随仓库级解析——保持触发 UI 零改动；规则/仓库级下拉仅列出 enabled 引擎。

### D3. DB 迁移 v9（全部增量，可空列/新表）

```sql
CREATE TABLE engine (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('ocr','claude-code','codex','custom-http','custom-script')),
  config TEXT NOT NULL DEFAULT '{}',          -- 类型相关配置 JSON（不含凭据，凭据走 credential 表）
  credential_id INTEGER REFERENCES credential(id),
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT
);
ALTER TABLE task ADD COLUMN engine_id INTEGER REFERENCES engine(id);
ALTER TABLE report ADD COLUMN engine TEXT;
ALTER TABLE repo ADD COLUMN engine_id INTEGER REFERENCES engine(id);      -- 可空=跟随全局
ALTER TABLE monitor_rule ADD COLUMN engine_id INTEGER REFERENCES engine(id); -- 可空=跟随仓库
CREATE TABLE mcp_server (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL CHECK (transport IN ('stdio','http')),
  config TEXT NOT NULL,                        -- {command,args,env} 或 {url,headers}
  enabled INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','repo')),
  repo_id INTEGER REFERENCES repo(id) ON DELETE CASCADE,
  tool_allowlist TEXT,                          -- JSON 数组，NULL=不限制
  timeout_sec INTEGER NOT NULL DEFAULT 10, created_at TEXT, updated_at TEXT
);
CREATE TABLE memory_entry (
  id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('architecture','convention','pitfall','suppression','history','glossary')),
  scope TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5, hits INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','rejected')),
  source_task_id INTEGER REFERENCES task(id) ON DELETE SET NULL,
  created_at TEXT, updated_at TEXT, last_used_at TEXT
);
CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory_entry', content_rowid='id');
-- 触发器同步 memory_entry → memory_fts（INSERT/UPDATE/DELETE）
CREATE TABLE memory_injection (
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  memory_id INTEGER NOT NULL REFERENCES memory_entry(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, memory_id)
);
CREATE TABLE review_feedback (
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES report_issue(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('false_positive','fixed','valid')),
  note TEXT, created_at TEXT,
  UNIQUE (issue_id, verdict)                    -- 同一 issue 同一判定只记一次，可撤销重标
);
```

- 启动时幂等 bootstrap：无任何 engine 记录则插入默认 ocr 引擎并设 `default_engine_id`。
- 备选：engine 表带 `is_default` 列——放弃，全局默认属于 setting（与 `default_provider_id` 同模式），避免双写。

### D4. ocr 适配器迁移

`ocrRunner.ts` 拆为：`engines/ocrEngine.ts`（capabilities + review()：组命令行/env/执行）+ 保留 `tasks/workspaceInit.ts`（被 prepare 复用）+ `reportService.parseOcrReport`（normalize 复用）。命令行组装新增两个可选项：`--requirement <file>`（记忆注入内容写入临时文件传入，规避命令行长度/转义问题；ocr 支持 `--requirement` 传文本，先验证文件入参支持，不支持则回退命令行文本）、MCP 段写入隔离 HOME `config.json`（扩展 `buildOcrConfig` 接受 `mcpServers` 参数）。

- 回归保障：迁移后跑 `scripts/smoke.mjs` 全流程 + 现有 vitest 套件。

### D5. MCP 注入器与连通性测试

`server/src/mcp/`：`service.ts`（CRUD + 校验）、`routes.ts`（`/api/mcp-servers`，管理员中间件）、`injector.ts`（按引擎 capabilities 分发：`config-inject` → 传给 engine 构造配置；`none` → 跳过）、`probe.ts`（连通性测试）。

- stdio 测试：spawn command → JSON-RPC `initialize` → `tools/list`（逐行 LSP 风格 Content-Length 分帧或换行 JSON，按 MCP stdio 规范换行分帧）→ 收集工具名 → kill 进程（Windows 上 kill 进程树）。
- http 测试：POST `initialize` 到 url（带 headers），2xx + 合法响应即成功。
- 注入内容过滤：`tool_allowlist` 非空时在注入配置中保留完整服务器但平台在审计中标注白名单（引擎侧过滤能力以 ocr 支持为准，平台侧仅审计不强改命令——避免拼错协议）。

### D6. 记忆实现（server/src/memory/）

- `store.ts`：CRUD + markdown 同步（`<DATA_DIR>/memory/<repo-id>/{profile.md,conventions.md,pitfalls.md,suppressions.md,modules/<scope-hash>.md}`）+ `reloadFromMarkdown()`（人工编辑后重载）。SQLite 为准，markdown 为投影。
- `retrieval.ts`：变更文件路径前缀匹配（scope）∪ FTS5 MATCH（变更标识符采样：文件名、新增行中的标识符）→ 排序 `confidence × recency(90d 半衰) × log(1+hits)` → 按预算截断。token 估算用 `Math.ceil(chars / 4)`（中英混合的保守近似，不引入分词依赖）。
- `inject.ts`：渲染为 markdown（架构/已知坑/已确认误报三段），经引擎能力通道注入（ocr → `--requirement`）；写 `memory_injection` + 更新 hits/last_used_at。
- `distill.ts`：评审成功后异步执行（不入任务关键路径）；prompt 输出严格 JSON（kind/scope/title/body/confidence），限额 5 条；合并规则：同 kind + 同 scope + 标题归一化（去空白/小写）相等或 FTS 相互命中 → 更新置信度（新=0.4 起，合并加权平均）。失败仅记日志表（`setting` 键 `memory_distill_last_error` 即可，P2 不单表）。
- `feedback.ts`：`/api/tasks/:id/feedback`（issue_id + verdict + note）→ 误报：查找同 scope+同 kind suppression 条目，命中计数≥3 则 confidence+0.1（上限 0.95），否则新建（confidence 0.7）；已修复：新建 history（confidence 0.6）。
- `evolve.ts`：评审完成计数（`setting` 键）每 +20 触发 compaction（合并重复 + 重写 profile.md）；每次检索前顺手执行归档扫描（90 天未命中且 confidence<0.3 → archived），代价 O(仓库条目数)，无需后台任务。

### D7. UI 增量

- 新页「引擎管理」「MCP 服务器」（导航栏系统组）；仓库详情加「项目记忆」tab（条目表格 + 编辑/停用/删除 + 生成画像按钮 + 注入历史）；任务详情加引擎徽标、MCP 统计、记忆注入条数；报告 issue 行尾加「误报 / 已修复」按钮（登录即可用，与现有单管理员模型一致）。
- 能力降级：引擎不支持 MCP/记忆时对应 UI 元素隐藏（读 capabilities，不入库）。

## Risks / Trade-offs

- [MCP 服务器 = 任意命令执行] → 仅管理员路由 + 页面风险明示 + 注入审计；不提供远程未鉴权入口（沿用 AUTH_REQUIRED 模型）
- [FTS5 在个别平台 prebuild 缺失] → v9 迁移前 `SELECT fts5(?1)` 探测，缺失时降级为 LIKE 检索并在日志告警（不阻断启动）
- [ocr `--requirement` 长度上限未知] → 注入预算默认 1500 token（约 6KB 文本），超长报文走临时文件注入；首版实现后实测调整
- [记忆污染（错误结论反复注入）] → 置信度门槛（<0.3 不召回）+ 单条可停用/删除 + 注入审计可回溯来源任务
- [蒸馏 LLM 成本] → 每次评审限 1 次蒸馏调用 + 5 条产出上限；蒸馏失败静默不影响任务
- [ocr 迁移回归] → 迁移为纯搬移 + 参数化，vitest + smoke 全量回归后再并入

## Migration Plan

1. v9 迁移在启动时自动执行（现有迁移框架），全部增量可空——旧数据零改写
2. bootstrap 插入默认 ocr 引擎；`task.engine_id` 为 NULL 的历史任务语义为"旧引擎记录"，报告页对 NULL 显示为 `ocr（历史）`
3. 回滚 = 回退二进制即可（新表残留无害）
4. 上线顺序：P1（引擎抽象 + ocr 迁移 + MCP）→ 验证 smoke → P2（记忆 v1：suppression/convention 注入 + 反馈闭环 + 蒸馏）→ 验证 → P3/P4 另立 change

## Open Questions

（无——`--requirement` 文件入参支持在 P1 实现时以最小脚本实测确定，回退路径已在 D4 给出，不影响规格与任务拆分。）
