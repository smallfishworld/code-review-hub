# Design

## Context

现有实现中评审执行逻辑集中在 `server/src/tasks/ocrRunner.ts`（构建 ocr 命令行、隔离 HOME、env 注入、解析输出），由 `taskQueue.ts` 直接调用；LLM Provider 经 `providers/ocrProviderConfig.ts` 生成隔离 `~/.opencodereview/config.json`（含 `language` 字段强制中文）。DB 迁移至 v8（`report_issue` 已有 `category` 列）。ocr ≥ 1.13 原生支持 `config.json` 的 `mcp_servers.<name>.<command|args|env|url|headers|enabled|type>` 配置与 `--requirement` 业务背景参数（已对照 1.13 二进制验证；但部署环境的二进制版本不受平台控制，`OcrEngine.probe()` 必须运行时校验版本并做能力门控，见 D4）。better-sqlite3 内置 FTS5（含 trigram 分词器）。另两个影响设计的现状事实：所有任务当前共享同一个 `<dataDir>/ocr-home`，而任务队列跨仓库并发上限为 2（`maxConcurrentRepos`）——config.json 内容一旦变为任务相关（MCP 注入），共享 HOME 即产生并发覆盖与跨仓库泄漏，见 D4；报告语言被强制为中文，记忆正文将以中文为主，影响 FTS 分词与 token 估算选择，见 D6。

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

- 接口签名：`probe(cfg)`（依赖与版本校验，返回运行时能力门控：MCP 注入 / 记忆注入是否可用）、`prepare(ctx)`（工作副本更新至目标节点，并返回变更文件列表与新增行标识符采样——SVN `diff --summarize -r <n-1>:<n>`、Git `diff <base>..<node>`，供记忆检索使用；采集失败返回空列表并记日志，不抛错）、`review(req, ctx)`（执行，返回原始输出 + usage + sessionId）、`normalize(raw)`（统一 issue 模型，行号映射到起始行 + 可选结束行）。
- 能力声明为静态常量（编译期），DB 不存能力——能力属于适配器代码而非用户配置，避免配置与代码不一致。
- 备选：把能力存 DB 由用户改——放弃，能力错了会导致任务必败。

### D2. 三级引擎选择

解析顺序：监控规则 `engine_id` → 仓库 `engine_id` → 全局默认（`setting.default_engine_id`，兼取第一条 enabled 记录兜底）。解析结果落 `task.engine_id`；解析失败（引擎不存在/停用）任务直接失败并在 `error` 中写明。手动触发不新增引擎下拉（v1），跟随仓库级解析——保持触发 UI 零改动；规则/仓库级下拉仅列出 enabled 引擎。auto 触发的任务因引擎解析失败而终态失败时，经现有通知渠道告警管理员（同规则去重，避免每次轮询重复告警）。

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
  config TEXT NOT NULL,                        -- {command,args,env} 或 {url,headers}；可能含敏感值，读取路径须脱敏（见 D5）
  enabled INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','repo')),
  repo_id INTEGER REFERENCES repo(id) ON DELETE CASCADE,
  tool_allowlist TEXT,                          -- JSON 数组，NULL=不限制
  timeout_sec INTEGER NOT NULL DEFAULT 10, created_at TEXT, updated_at TEXT,
  CHECK ((scope = 'global' AND repo_id IS NULL) OR (scope = 'repo' AND repo_id IS NOT NULL))
);
CREATE TABLE memory_entry (
  id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('architecture','convention','pitfall','suppression','history','glossary')),
  scope TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
  fingerprint TEXT,                            -- 误报指纹：suppression 必填（文件路径前缀 + 问题特征归一化哈希），其余 NULL
  confidence REAL NOT NULL DEFAULT 0.5, hits INTEGER NOT NULL DEFAULT 0,
  feedback_count INTEGER NOT NULL DEFAULT 0,   -- 人工确认次数（反馈闭环），与检索命中 hits 独立
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','rejected')),
  source_task_id INTEGER REFERENCES task(id) ON DELETE SET NULL,
  created_at TEXT, updated_at TEXT, last_used_at TEXT
);
CREATE INDEX idx_memory_fingerprint ON memory_entry(repo_id, fingerprint);
CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, content='memory_entry', content_rowid='id', tokenize='trigram');  -- unicode61 对中文整段切单 token，平台报告强制中文，必须 trigram
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
  memory_id INTEGER REFERENCES memory_entry(id) ON DELETE SET NULL,  -- 本次反馈生成/强化的记忆条目，可追溯
  note TEXT, created_at TEXT,
  UNIQUE (issue_id, verdict)                    -- 同一 issue 同一判定只记一次，可撤销重标
);
CREATE TABLE task_mcp_injection (               -- MCP 注入与调用审计的持久化位置（不塞 task 行）
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  server_id INTEGER NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  server_name TEXT NOT NULL,                   -- 快照：服务器删除后审计仍可读
  allowlist_enforced INTEGER NOT NULL DEFAULT 0,
  tool_stats TEXT,                             -- JSON {tool:{calls,failures}}；引擎未上报时 NULL
  PRIMARY KEY (task_id, server_id)
);
ALTER TABLE report_issue ADD COLUMN end_line INTEGER;                               -- 引擎提供区间行号时携带
ALTER TABLE report_issue ADD COLUMN suppressed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_issue ADD COLUMN suppressed_by INTEGER REFERENCES memory_entry(id) ON DELETE SET NULL;
```

- MCP 审计独立建表 `task_mcp_injection`（server_name 快照 + tool_stats JSON），任务详情据此渲染——不往 task 表加 JSON 列，避免宽表语义不清；`report_issue` 的 `end_line`/`suppressed`/`suppressed_by` 支撑区间行号与确定性抑制（D6）。
- 启动时幂等 bootstrap：无任何 engine 记录则插入默认 ocr 引擎并设 `default_engine_id`。
- 备选：engine 表带 `is_default` 列——放弃，全局默认属于 setting（与 `default_provider_id` 同模式），避免双写。

### D4. ocr 适配器迁移、按仓库隔离 HOME 与版本门控

`ocrRunner.ts` 拆为：`engines/ocrEngine.ts`（capabilities + review()：组命令行/env/执行）+ 保留 `tasks/workspaceInit.ts`（被 prepare 复用）+ `reportService.parseOcrReport`（normalize 复用）。

- **HOME 隔离粒度从全平台共享改为按仓库**：现状所有任务共享 `<dataDir>/ocr-home`，内容与任务无关时无害；MCP 注入使 config.json 变为任务相关后，共享目录会被并发任务（`maxConcurrentRepos=2`）互相覆盖，甚至把 A 仓库绑定的 MCP 服务器泄漏进 B 仓库的评审。HOME 改为 `<dataDir>/ocr-home/<repo-id>/`（同仓库任务本就串行复用，仓库级 MCP 绑定对其为常量）；每仓库 HOME 首次创建时生成 svn `servers` 证书配置，SVN 凭据种子（cacheAuth checkout）写入各自 HOME 的 auth store。旧共享 `ocr-home` 弃用不迁移（config 每任务重生成）。providerTester 沿用一次性临时目录。
- **版本门控**：`probe()` 解析 `ocr --version`，< 1.13 时运行时能力降级——不写 `mcp_servers` 段、不传 `--requirement`（记忆注入跳过），任务记录标注降级原因，评审照常执行。
- 命令行组装新增两个可选项（均受版本门控）：`--requirement <file>`（记忆注入内容写入临时文件传入，规避命令行长度/转义问题；文件入参在 P1 以最小脚本实测，不支持则回退命令行文本——6KB 预算在命令行长度上限内安全）、MCP 段写入该仓库 HOME 的 `config.json`（扩展 `buildOcrConfig` 接受 `mcpServers` 参数）。

- 回归保障：迁移后跑 `scripts/smoke.mjs` 全流程 + 现有 vitest 套件；smoke 增加两仓库并发评审用例，断言注入互不污染。

### D5. MCP 注入器与连通性测试

`server/src/mcp/`：`service.ts`（CRUD + 校验）、`routes.ts`（`/api/mcp-servers`，管理员中间件）、`injector.ts`（按引擎 capabilities 分发：`config-inject` → 传给 engine 构造配置；`none` → 跳过）、`probe.ts`（连通性测试）。

- stdio 测试：spawn command → JSON-RPC `initialize` → `tools/list`（逐行 LSP 风格 Content-Length 分帧或换行 JSON，按 MCP stdio 规范换行分帧）→ 收集工具名 → kill 进程（Windows 上 kill 进程树）。
- http 测试：按 Streamable HTTP 语义 POST `initialize`（`Accept: application/json, text/event-stream` 双头，SSE 响应需解帧取 JSON-RPC 结果），成功后 `tools/list` 枚举工具；initialize 成功而 tools/list 失败时结果区分展示。
- 注入内容过滤（与 mcp-integration spec 的「尽力强制」条款对齐）：`tool_allowlist` 非空且引擎支持按工具过滤时走强制路径；ocr 的 config-inject 不支持按工具过滤，此情形保留完整服务器注入、在 `task_mcp_injection.allowlist_enforced=0` 标注「未强制」，控制台与任务详情相应提示——平台不猜测引擎的私有过滤协议。
- 敏感值脱敏：`mcp_server.config` 允许含凭据（http headers 的 Authorization、stdio env 的 token）。读取路径（列表/详情/测试结果）对 headers 与 env 的值掩码回显（保留键名），完整值仅用于注入与连通性测试；v1 明文入库不拆 credential 表（env 键值对中常只有部分是凭据，拆分收益低），README 风险提示注明。

### D6. 记忆实现（server/src/memory/）

- `store.ts`：CRUD + markdown 同步（`<DATA_DIR>/memory/<repo-id>/{profile.md,conventions.md,pitfalls.md,suppressions.md,modules/<scope-hash>.md}`）+ `reloadFromMarkdown()`（人工编辑后重载）。SQLite 为准，markdown 为投影。
- `retrieval.ts`：输入为 `prepare()` 采集的变更文件列表与新增行标识符。召回 = 变更路径前缀匹配 scope ∪ FTS5 MATCH（文件名与标识符逐串用双引号包裹——`-`、`(` 等字符是 FTS5 运算符，不包裹会语法错）→ 排序 `confidence × recency(90d 半衰) × log(1+hits)` → 按预算截断。token 估算按中英混合：`ceil(ASCII 字符数 / 4) + ceil(非 ASCII 字符数 × 1.5)`——纯中文按 4 字符/token 会低估 6–8 倍，预算形同虚设。
- `inject.ts`：渲染为 markdown（架构/已知坑/已确认误报三段），经引擎能力通道注入（ocr → `--requirement`）；写 `memory_injection` + 更新 hits/last_used_at。
- `suppressFilter.ts`：报告管道内、normalize 之后入库之前执行——按 (repo_id, fingerprint) 加载激活 suppression，与归一化 issue 匹配（文件前缀 + 指纹），命中置 `suppressed=1` + `suppressed_by`；报告视图与通知默认排除被抑制条目，报告详情 API 附被抑制清单供展开。确定性执行，不依赖引擎遵从 `--requirement` 注入——这是「suppression 命中不再复报」验收标准的实际保障。
- `distill.ts`：评审成功后异步执行（不入任务关键路径）；prompt 输出严格 JSON（kind/scope/title/body/confidence），限额 5 条；合并规则：同 kind + 同 scope + 标题归一化（去空白/小写）相等或 FTS 相互命中 → 更新置信度（新=0.4 起，合并加权平均）。失败仅记日志表（`setting` 键 `memory_distill_last_error` 即可，P2 不单表）。
- `feedback.ts`：`/api/tasks/:id/feedback`（issue_id + verdict + note）→ 误报：计算误报指纹（文件路径前缀 + category + 描述归一化（去行号/去空白/小写）哈希），按 (repo_id, fingerprint) 查找 suppression——命中则 `feedback_count+1`（每达 3 的倍数 confidence+0.1，上限 0.95）并合并正文；未命中新建（confidence 0.7，feedback_count=1）；已修复：新建 history（confidence 0.6）。`review_feedback.memory_id` 回写关联条目；幂等由 UNIQUE (issue_id, verdict) 保证。
- `evolve.ts`：评审完成计数（`setting` 键）每 +20 触发 compaction（合并重复 + 重写 profile.md）；每次检索前顺手执行归档扫描（90 天未命中且 confidence<0.3 → archived），代价 O(仓库条目数)，无需后台任务。

### D7. UI 增量

- 新页「引擎管理」「MCP 服务器」（导航栏系统组）；仓库详情加「项目记忆」tab（条目表格 + 编辑/停用/删除 + 生成画像按钮 + 注入历史）；任务详情加引擎徽标、MCP 统计、记忆注入条数；报告 issue 行尾加「误报 / 已修复」按钮（登录即可用，与现有单管理员模型一致）。
- 能力降级：引擎不支持 MCP/记忆时对应 UI 元素隐藏（读 capabilities，不入库）。报告详情折叠展示被抑制 issue（含命中记忆链接）；任务详情 MCP 区展示 allowlist 是否强制与「引擎未上报统计」标注；MCP 服务器页配置回显脱敏。

## Risks / Trade-offs

- [MCP 服务器 = 任意命令执行] → 仅管理员路由 + 页面风险明示 + 注入审计；不提供远程未鉴权入口（沿用 AUTH_REQUIRED 模型）
- [并发任务共享 HOME → 跨仓库 MCP 泄漏/配置覆盖] → HOME 按仓库隔离（D4），smoke 加并发注入用例
- [确定性抑制误伤真实问题] → 抑制只标记不删除、报告详情可展开回溯、suppression 条目可停用；指纹含 category 与描述归一化，降低误匹配
- [FTS5 在个别平台 prebuild 缺失 / trigram 需 SQLite ≥ 3.34] → v9 迁移前探测 FTS5 与 trigram 可用性，缺失时降级为 LIKE 检索并在日志告警（不阻断启动）
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

1. ocr `--requirement` 是否接受文件路径入参——P1 以最小脚本实测；不支持则回退命令行文本（回退路径见 D4，6KB 预算在命令行长度上限内安全，不影响规格与任务拆分）。
2. ocr JSON 输出是否包含 MCP 工具调用统计——实测；缺失时 `task_mcp_injection.tool_stats` 为 NULL 并在 UI 标注「引擎未上报统计」（spec 已按条件式措辞）。
3. ocr `mcp_servers` 的 http 传输 `type` 字段取值（`http` / `sse` / `streamable-http`）——以 1.13 二进制的配置解析实测为准。
