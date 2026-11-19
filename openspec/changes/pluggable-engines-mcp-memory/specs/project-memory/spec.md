# Spec Delta

## Purpose

平台按仓库维护随评审积累的项目记忆：评审前检索注入相关记忆帮助引擎理解工程背景与规避已知误报，评审后从结果与人工反馈中蒸馏新记忆，使同一工程的评审随使用次数增多而更准、更快。记忆对用户完全可见可编辑，任何自动写入都可追溯来源任务。

## ADDED Requirements

### Requirement: 记忆条目模型

每个仓库 SHALL 拥有独立的记忆集合，条目字段 MUST 包含：类型（architecture / convention / pitfall / suppression / history / glossary 六类之一）、作用范围（路径前缀或模块名，空表示全仓库）、标题、正文、置信度（0–1）、命中次数、状态（active / archived / rejected）、来源任务（可空）。条目 MUST 同时持久化为 markdown 文件（`<DATA_DIR>/memory/<repo-id>/` 下按类型组织）与 SQLite 索引（含 FTS5 全文索引）；两者以 SQLite 为准，markdown 可随时从索引重建，用户手工编辑 markdown 后平台 SHALL 提供重新加载入口。

#### Scenario: 查看仓库记忆
- **WHEN** 用户打开仓库详情的项目记忆 tab
- **THEN** 展示该仓库全部记忆条目（类型、范围、标题、置信度、命中次数、状态）及其来源任务链接

#### Scenario: 手动编辑记忆
- **WHEN** 用户在记忆 tab 编辑、停用或删除某条记忆
- **THEN** 变更即时生效于后续评审的检索，且 markdown 文件同步更新

### Requirement: 评审前检索注入

评审任务启动前，平台 SHALL 基于变更文件列表检索该仓库的记忆：按作用范围前缀匹配 + FTS 全文匹配召回，按 置信度×时间新近度×命中次数 排序，注入内容截断至固定 token 预算（默认 1500）。注入经由引擎能力声明的通道（ocr 为 `--requirement` 业务背景参数）；引擎不支持注入时 MUST 跳过且任务正常执行。每次实际注入的条目集合 MUST 记录到任务（注入审计），被注入条目的命中次数与最近命中时间 MUST 更新。

#### Scenario: 命中抑制记忆
- **WHEN** 变更文件命中一条 suppression 记忆（此前被人工确认的误报模式），且任务引擎为 ocr
- **THEN** 该记忆内容随业务背景一并发给引擎，注入审计记录该条目

#### Scenario: 记忆为空或引擎不支持
- **WHEN** 仓库没有任何 active 记忆，或引擎记忆注入能力为 none
- **THEN** 评审正常执行，不注入，任务详情不展示记忆统计

#### Scenario: 预算截断
- **WHEN** 召回的记忆内容总量超过 token 预算
- **THEN** 按排序得分从高到低保留，超出部分不注入

### Requirement: 评审后蒸馏写入

评审任务成功后，平台 SHALL 触发记忆蒸馏：将本次变更与评审发现交给 LLM 按严格结构输出候选记忆，单次蒸馏 MUST 限额（每次评审最多新增 3–5 条）；候选条目与既有记忆合并——同类型同范围内标题语义相近时更新已有条目（置信度加权平均）而非新增。蒸馏失败（LLM 不可用、输出不合规）MUST 不影响评审任务本身的结果与报告。

#### Scenario: 蒸馏产出新约定
- **WHEN** 一次成功评审中 LLM 蒸馏出 2 条新的 convention 候选
- **THEN** 2 条以低置信度写入该仓库记忆，markdown 同步生成，来源任务可追溯

#### Scenario: 与既有记忆合并
- **WHEN** 蒸馏候选与既有条目同类型同范围且标题相近
- **THEN** 更新既有条目正文与置信度，不产生重复条目

#### Scenario: 蒸馏失败不影响任务
- **WHEN** 蒸馏阶段 LLM 调用失败
- **THEN** 评审任务状态保持成功、报告完整可浏览，仅记忆不更新（失败原因记录在蒸馏日志）

### Requirement: issue 反馈闭环

报告的每条 issue SHALL 提供「误报」与「已修复」反馈操作（登录用户可用）。标记误报 MUST 生成或强化一条 suppression 记忆（含文件匹配范围、原因、来源 issue）；标记已修复 MUST 生成一条 history 记忆；同一模式连续 3 次被标记误报时，对应 suppression 条目置信度 MUST 提升。反馈操作 MUST 记录到 review_feedback 表并可追溯。

#### Scenario: 标记误报
- **WHEN** 用户对某条 issue 点击误报并提交原因
- **THEN** 生成 suppression 记忆并在下次评审前可被召回注入；该 issue 标记反馈状态

#### Scenario: 重复误报提升置信度
- **WHEN** 相似模式第 3 次被标记误报
- **THEN** 对应 suppression 条目置信度按规则提升，注入排序更靠前

### Requirement: 记忆演化与治理

平台 SHALL 实施记忆演化规则：人工确认（反馈闭环）提升置信度、长期未命中降低置信度；90 天未命中且置信度低于阈值的条目自动归档（不删除）；每完成 20 次评审触发一次 compaction（合并重复、重写项目画像概览），compaction MUST 限额且结果可审计。所有演化动作（归档、合并、置信度变化）SHALL 在记忆 tab 可见。

#### Scenario: 自动归档陈旧记忆
- **WHEN** 某条 active 记忆超过 90 天未命中且置信度低于阈值
- **THEN** 下一次演化检查将其置为 archived，不再参与召回

#### Scenario: compaction 合并重复
- **WHEN** 仓库累计完成第 20 次评审触发 compaction
- **THEN** 重复条目被合并、条目总数下降或持平，动作记录可查

### Requirement: 冷启动项目画像

对尚无记忆的仓库，平台 SHALL 提供项目画像生成：扫描仓库工作副本，产出 architecture / convention 类的基础记忆（技术栈、模块划分、构建与测试方式、关键约定），并生成 `profile.md`。画像生成 MUST 手动触发（仓库详情按钮）且可重复执行（覆盖更新）。

#### Scenario: 首次生成画像
- **WHEN** 用户对新仓库点击生成项目画像并等待完成
- **THEN** 该仓库出现 architecture/convention 类记忆条目与 profile.md，后续评审默认注入其中相关内容

#### Scenario: 重复生成
- **WHEN** 用户对已有画像的仓库再次点击生成
- **THEN** 基础类记忆被更新而非重复新增
