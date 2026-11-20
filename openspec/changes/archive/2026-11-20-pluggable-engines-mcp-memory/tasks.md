# Tasks

## 1. DB 迁移 v9 与引擎引导（P1）

- [ ] 1.1 在 `server/src/db/database.ts` 增加 v9 迁移：`engine`、`mcp_server`（含 scope/repo_id 一致性 CHECK）、`memory_entry`（含 fingerprint/feedback_count）+ `memory_fts`（FTS5 trigram + 同步触发器）、`memory_injection`、`review_feedback`（含 memory_id）、`task_mcp_injection` 表，`task`/`report`/`repo`/`monitor_rule` 增加可空列，`report_issue` 增加 `end_line`/`suppressed`/`suppressed_by`；迁移前探测 FTS5 与 trigram 可用性，缺失时降级为 LIKE 检索路径并告警。验证：`npm test` 中 database 测试通过，v8 库升级后新表/新列存在、旧数据未变
- [ ] 1.2 实现启动时幂等 bootstrap：无 engine 记录时插入默认 ocr 引擎并写 `default_engine_id`。验证：单测断言空库启动后恰有一条 ocr 引擎且重复启动不重复插入

## 2. 引擎抽象与 ocr 适配器迁移（P1）

- [ ] 2.1 新增 `server/src/engines/types.ts`：`ReviewEngine` 接口（probe/prepare/review/normalize + capabilities: vcs/revisionMode/fullFileScan/mcp/memoryInjection/resume/streaming）与 `NormalizedIssue` 模型。验证：`npx tsc --noEmit` 通过
- [ ] 2.2 将 `tasks/ocrRunner.ts` 逻辑迁入 `engines/ocrEngine.ts`（命令行组装、隔离 HOME/env、`--commit` 执行、输出采集），`workspaceInit.ts` 与 `parseOcrReport` 复用不动；taskQueue 改为经 `engines/registry.ts` 按记录实例化并调用接口。验证：现有 ocrRunner/taskQueue 单测全部迁移并通过，`npm test` 绿
- [ ] 2.3 normalize 容错：单条 issue 字段缺失/类型错误时降级为仅文本描述或跳过，不使整份报告失败。验证：单测构造含脏数据的 ocr JSON，断言好条目入库、任务不失败
- [ ] 2.4 报告记录引擎：`report.engine` 写入任务解析到的引擎名，任务详情 API 与列表返回 engine 字段（NULL 显示 `ocr（历史）`）。验证：单测断言报告落库 engine 值；页面任务详情可见引擎徽标
- [ ] 2.5 ocr HOME 按仓库隔离（`<DATA_DIR>/ocr-home/<repo-id>/`）：`prepareOcrHome` 增加仓库目录参数，每仓库 HOME 生成 svn `servers` 证书配置、SVN 凭据种子写入各自 auth store；`probe()` 解析 `ocr --version`，< 1.13 时运行时降级（不注入 `mcp_servers`、不传 `--requirement`）并在任务记录标注降级原因。验证：单测覆盖 HOME 路径按仓库区分与版本门控分支；旧共享 `ocr-home` 弃用后 smoke 评审正常

## 3. 三级引擎选择（P1）

- [ ] 3.1 实现 engineResolver：监控规则 `engine_id` → 仓库 `engine_id` → 全局默认（setting `default_engine_id`，兜底第一条 enabled）；解析结果写 `task.engine_id`，引擎缺失/停用时任务失败且 error 写明原因。验证：单测覆盖三级覆盖与失败路径
- [ ] 3.2 引擎 CRUD 路由 `/api/engines`（列表/新增/修改/启停/设默认，仅管理员），名称唯一与 kind 校验。验证：路由单测覆盖校验失败与启停后不可被任务解析
- [ ] 3.3 仓库编辑表单与监控规则表单增加引擎下拉（仅列出 enabled 引擎，空=跟随上一级）。验证：手动验证保存与回显；触发任务后 task.engine_id 符合解析顺序

## 4. MCP 注册表与注入（P1）

- [ ] 4.1 `server/src/mcp/service.ts` + `/api/mcp-servers` 路由（仅管理员）：CRUD、transport 相应字段校验（stdio 必有 command、http 必有 url）、scope/repo 绑定、tool_allowlist、timeout_sec。验证：路由单测覆盖非法配置拒绝与 scope 级联删除
- [ ] 4.2 `mcp/injector.ts`：任务执行时收集生效服务器（global enabled + 该仓库 enabled），按引擎 capabilities 分发——`config-inject` 时扩展 `buildOcrConfig` 写入该仓库隔离 HOME `config.json` 的 `mcp_servers` 段（依赖 2.5），`none` 跳过；注入清单（server_name 快照、allowlist 是否强制）落库 `task_mcp_injection`。验证：单测断言生成的 ocr config.json 含 mcp_servers 条目且两仓库并发任务互不污染，`none` 引擎配置不含且不落注入记录
- [ ] 4.3 `mcp/probe.ts` 连通性测试：stdio spawn + initialize + tools/list（换行 JSON 分帧、超时 kill 进程树）；http 按 Streamable HTTP 语义（Accept 双头、SSE 解帧）initialize + tools/list，initialize 成功而 tools/list 失败时区分标注；`/api/mcp-servers/:id/test` 返回工具清单或失败原因，不改动注册表。验证：单测用本地 mock 脚本/服务器覆盖成功、启动失败、超时、工具枚举失败四路径
- [ ] 4.4 调用审计：评审完成后从引擎输出采集 tool_calls 统计写入 `task_mcp_injection.tool_stats`，引擎未上报时置 NULL 并标注「引擎未上报统计」；任务详情 API 返回注入清单 + 统计。验证：单测覆盖有统计 / 无统计两条路径
- [ ] 4.5 敏感配置脱敏：`/api/mcp-servers` 读取路径对 headers/env 的值掩码回显（保留键名），完整值仅用于注入与连通性测试。验证：路由单测断言响应不含明文凭据、注入路径仍使用完整值

## 5. P1 集成回归

- [ ] 5.1 全量回归：`npm run lint`、`npm test`、`npm run build` 通过；运行 `scripts/smoke.mjs` 全流程确认 ocr 迁移零回归（评审、报告、通知、监控、重启恢复）。验证：冒烟输出全阶段通过

## 6. 记忆存储与检索注入（P2）

- [ ] 6.1 `prepare()` 变更采集：SVN `diff --summarize -r <n-1>:<n>`、Git `diff <base>..<node>` 产出变更文件列表与新增行标识符采样，供记忆检索使用；采集失败降级为空列表并记日志，任务不失败。验证：单测 mock vcs 输出覆盖正常与失败路径
- [ ] 6.2 `server/src/memory/store.ts`：memory_entry CRUD（含 fingerprint/feedback_count 透传）+ markdown 投影（`<DATA_DIR>/memory/<repo-id>/` 按类型组织）+ `reloadFromMarkdown()`。验证：单测覆盖增删改后 markdown 同步、重载一致
- [ ] 6.3 `memory/retrieval.ts`：scope 前缀匹配 ∪ FTS（trigram）召回（MATCH 入参逐串双引号包裹防语法错）→ `confidence × recency × log(1+hits)` 排序 → 1500 token 预算（ASCII/4 + 非ASCII×1.5 混合估算）截断；变更列表为空时降级为仅全仓库 scope + FTS。验证：单测覆盖中英文召回、排序、截断、低置信度过滤与 MATCH 转义
- [ ] 6.4 `memory/inject.ts`：按引擎 capabilities 通道注入（ocr 经 `--requirement`，先以最小脚本实测文件入参，不支持则命令行文本回退；版本门控降级时跳过），写 `memory_injection` 并更新 hits/last_used_at。验证：单测断言注入审计落库、命中计数更新；真实 ocr 冒烟任务详情可见注入条数
- [ ] 6.5 仓库记忆路由 `/api/repos/:id/memory`（列表/编辑/停用/删除/重载 markdown，管理员）。验证：路由单测 + 手动验证控制台编辑生效

## 7. 反馈闭环、确定性抑制与蒸馏演化（P2）

- [ ] 7.1 `POST /api/tasks/:id/feedback`（issue_id + verdict + note）：误报计算指纹（文件路径前缀 + category + 描述归一化哈希）按 (repo, fingerprint) 聚合——命中则 feedback_count+1（每达 3 的倍数 confidence+0.1 上限 0.95）并合并正文，未命中新建（confidence 0.7）；已修复生成 history；`review_feedback.memory_id` 回写关联，同 issue 同判定幂等。验证：单测覆盖新建、按指纹聚合强化（含不同 issue 同指纹）、幂等与撤销重标
- [ ] 7.2 `memory/suppressFilter.ts`：报告管道 normalize 后、入库前按 (repo, fingerprint) 匹配激活 suppression，命中置 `suppressed/suppressed_by`；报告视图与通知默认排除，报告详情 API 附被抑制清单。验证：单测覆盖命中、未命中、条目停用后不再抑制；与 9.1 端到端串联
- [ ] 7.3 `memory/distill.ts`：评审成功后异步蒸馏（严格 JSON 输出、单次 ≤5 条、合并规则：同 kind 同 scope + 标题归一化/FTS 互击 → 更新加权置信度）；失败仅记 `memory_distill_last_error` 不影响任务。验证：单测以 mock LLM 覆盖产出限额、合并去重、失败静默
- [ ] 7.4 `memory/evolve.ts`：检索时顺带归档扫描（90 天未命中且 confidence<0.3 → archived）；评审计数每 20 次 compaction（合并重复 + 重写 profile.md）。验证：单测覆盖归档阈值与 compaction 幂等
- [ ] 7.5 冷启动画像：仓库详情手动触发生成画像（扫描工作副本 → architecture/convention 基础记忆 + profile.md，可重复执行为更新）。验证：单测以 mock LLM 断言重复生成不重复新增条目

## 8. Web 控制台增量（P1+P2）

- [ ] 8.1 引擎管理页（列表/新增/编辑/启停/设默认）与能力驱动降级（引擎不支持 MCP/记忆时相关 UI 隐藏）。验证：手动验证 CRUD 全流程 + `npm run build` 通过
- [ ] 8.2 MCP 服务器页（CRUD、作用域绑定、连通性测试按钮展示工具清单、风险提示文案）。验证：手动验证注册→测试→绑定仓库全流程
- [ ] 8.3 仓库详情「项目记忆」tab（条目表格含类型/范围/置信度/命中/状态/来源任务、编辑/停用/删除、重载 markdown、生成画像按钮、注入历史）。验证：手动验证编辑即时生效于下一次评审注入
- [ ] 8.4 任务详情增强：引擎徽标、MCP 注入清单与工具统计（含「引擎未上报统计」与「白名单未强制」标注）、记忆注入条数；报告 issue 行尾「误报 / 已修复」按钮（提交后标记反馈状态）；报告详情折叠展示被抑制 issue（含命中记忆链接）。验证：手动验证按钮→feedback 落库→记忆 tab 出现 suppression 条目→再次评审同类 issue 默认不展示；`npm run lint` 通过
- [ ] 8.5 控制台深浅两主题下新增元素样式核对（严重级别/类型标签既有 token 复用，文字标签始终伴随颜色，对比度 ≥ 4.5:1）。验证：浅色与深色模式截图核对

## 9. P2 集成回归与文档

- [ ] 9.1 全量回归：`npm test`、`npm run build`、`scripts/smoke.mjs` 全阶段通过（含两仓库并发 MCP 注入互不污染用例）；补一条端到端验证：误报反馈 → suppression 生成 → 再次评审同类 issue 被确定性抑制默认不展示（记录在测试说明）。验证：冒烟输出全阶段通过
- [ ] 9.2 README 更新：引擎管理 / MCP / 项目记忆章节（配置方式、风险提示、ocr ≥ 1.13 要求与 MCP 能力说明）。验证：文档段落与实际路由/页面一致，构建产物不受影响

## Workflow follow-up

- 实现全部完成后：评审各 spec 场景覆盖情况，确认无未实现需求后执行 `openspec-archive-change` 归档本 change 并同步主 specs
- P3/P4（claude-code 适配器、平台侧 MCP 客户端、记忆蒸馏增强）另立 change，不在本 change 归档条件内
