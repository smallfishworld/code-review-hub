# Spec Delta

## Purpose

平台通过统一的评审引擎抽象执行代码评审：引擎可插拔（ocr 为首个适配器），按三级优先级选择引擎，评审输出归一化为平台统一的 issue 模型，报告记录实际使用的引擎。对使用者而言，无论底层引擎是什么，任务触发、报告浏览、通知的行为保持一致。

## ADDED Requirements

### Requirement: 引擎注册与能力声明

平台 SHALL 维护评审引擎注册表，每个引擎 MUST 声明其能力（capabilities）：支持的 VCS 类型（svn/git）、revision 模式（单节点/区间）、是否全文件扫描、MCP 接入方式（config-inject / cli-flag / none）、记忆注入方式（requirement / rules-file / prompt / none）、是否支持会话恢复（resume）、是否支持流式输出。引擎配置 MUST 包含：名称、类型（ocr / claude-code / codex / custom-http / custom-script）、类型相关配置（JSON）、启停状态。

#### Scenario: 首次启动无引擎配置
- **WHEN** 平台启动且数据库中不存在任何引擎记录
- **THEN** 平台自动注册一个默认 ocr 引擎（配置继承现有 LLM Provider 行为）并设为全局默认，现有评审行为不受影响

#### Scenario: 引擎能力驱动的界面降级
- **WHEN** 用户在控制台查看某个引擎
- **THEN** 界面按该引擎声明的能力展示可配置项（不支持 MCP 的引擎不展示 MCP 绑定，不支持区间评审的引擎在触发页禁用区间输入）

### Requirement: 三级引擎选择

评审任务的引擎 SHALL 按三级优先级解析：监控规则级覆盖 → 仓库级覆盖 → 全局默认。解析结果 MUST 写入任务的 `engine_id`；`engine_id` 无效（记录已删除或停用）时任务 MUST 失败并给出明确原因，不得静默回退到其他引擎。

#### Scenario: 仓库级覆盖全局默认
- **WHEN** 全局默认引擎为 A，仓库 R 配置了引擎 B，对 R 触发评审任务
- **THEN** 任务使用引擎 B 执行，任务记录的 engine_id 为 B

#### Scenario: 规则级覆盖仓库级
- **WHEN** 仓库 R 配置了引擎 B，R 上的监控规则 X 配置了引擎 C，规则 X 命中产生任务
- **THEN** 任务使用引擎 C 执行

#### Scenario: 引擎被删除后触发
- **WHEN** 任务解析到的引擎记录已不存在或已停用
- **THEN** 任务以失败终态结束，失败原因说明引擎不可用

### Requirement: 评审执行与输出归一化

平台 SHALL 通过统一的引擎接口执行评审：准备/更新工作副本、执行评审、归一化输出。各引擎的私有输出格式 MUST 被归一化为平台统一的 issue 模型（文件路径、行号——起始行必填、结束行在引擎提供时可选携带、severity（critical/high/medium/low 或空）、category（bug/security/performance/maintainability/test/style/documentation/other 或空）、描述、修复建议）。归一化 MUST 容错：单条 issue 字段缺失或类型错误不得导致整个报告解析失败。

#### Scenario: ocr 引擎产出归一化报告
- **WHEN** ocr 引擎完成一次评审并输出其原生 JSON
- **THEN** 平台将其 comments 归一化为统一 issue 模型入库，报告浏览与通知行为与现状一致

#### Scenario: 引擎输出单条数据损坏
- **WHEN** 引擎原始输出的 issue 列表中某条记录字段缺失或类型错误
- **THEN** 该条被跳过或降级为仅文本描述，其余 issue 正常入库，任务不失败

### Requirement: 报告引擎归属

每份评审报告 MUST 记录产生它的引擎标识；任务详情与报告页 SHALL 展示该标识。同一仓库节点用不同引擎评审产生的报告 MUST 可区分。

#### Scenario: 报告展示引擎
- **WHEN** 用户查看一次由非默认引擎产生的评审报告
- **THEN** 报告页与任务列表显示该任务的引擎名称

### Requirement: ocr 适配器行为保持

ocr 引擎适配器 MUST 保持现有对外行为：SVN 按 `--commit <rev>` 评审单节点、Git 按 commit sha 评审、区间任务逐节点展开、LLM Provider 注入与中文报告语言、SVN 证书与凭据处理、JSON 报告解析。隔离 HOME 的粒度从全平台共享调整为按仓库隔离：跨仓库并发任务 MUST 使用各自独立的运行 HOME（含 SVN 证书与凭据配置），互不污染；同仓库任务串行复用其 HOME。迁移到适配器结构后，现有冒烟流程 MUST 全部通过。

#### Scenario: 迁移后行为回归
- **WHEN** ocr 逻辑迁移为引擎适配器后运行跨平台冒烟
- **THEN** 冒烟各阶段（仓库配置、手动评审、报告、通知、自动监控、重启恢复）全部通过，行为与迁移前一致

#### Scenario: 跨仓库并发隔离
- **WHEN** 两个不同仓库的评审任务并行执行
- **THEN** 各自使用独立的 ocr HOME，任一任务的配置写入不影响另一任务
