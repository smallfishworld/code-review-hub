# Spec Delta

## Purpose

通过封装 `ocr` CLI 对 SVN 或 Git 上库节点执行 AI 代码评审：支持单节点（SVN revision / Git commit）与节点区间的手动触发，管理评审任务的生命周期，并将评审报告持久化留存。

## ADDED Requirements

### Requirement: 手动评审单个 SVN revision

系统 SHALL 支持用户通过 Web 控制台对一个已配置的 SVN 仓库指定 revision 号，发起对该单个上库节点的评审。评审内容 SHALL 为该 revision 相对其前一 revision 的变更。

#### Scenario: 触发单节点评审
- **WHEN** 用户在 Web 控制台选择 SVN 仓库并输入 revision 号 1234，点击"开始评审"
- **THEN** 系统创建一个评审任务，状态为"排队"，随后自动开始执行
- **AND** 评审完成后任务状态变为"成功"，可查看该 revision 的评审报告

#### Scenario: revision 不存在
- **WHEN** 用户输入的 revision 号在仓库中不存在
- **THEN** 任务以"失败"状态结束，失败原因中包含 SVN 返回的错误信息

### Requirement: 手动评审单个 Git commit

系统 SHALL 支持用户对一个已配置的 Git 仓库指定 commit（完整或短哈希）或所在分支的最新提交，发起对该提交的评审。

#### Scenario: 触发 Git 单提交评审
- **WHEN** 用户选择 Git 仓库并输入 commit 哈希 a1b2c3d，点击"开始评审"
- **THEN** 系统创建一个评审任务，评审该 commit 引入的变更并生成报告

#### Scenario: commit 不存在
- **WHEN** 用户输入的 commit 哈希在仓库中不存在或不唯一
- **THEN** 系统拒绝创建任务并返回明确错误提示，不产生失败任务

### Requirement: 手动评审节点区间

系统 SHALL 支持用户指定起止节点发起区间评审：SVN 仓库为起止 revision（from < to），Git 仓库为分支区间或起止 commit。对区间内的每个节点，系统 SHALL 各自生成一份独立的评审报告。

#### Scenario: 触发 SVN 区间评审
- **WHEN** 用户输入 from=1200、to=1230，点击"开始评审"
- **THEN** 系统为区间内每个 revision 创建独立的评审任务，并可分别查看各节点的报告

#### Scenario: 触发 Git 区间评审
- **WHEN** 用户对 Git 仓库输入起始 commit 与结束 commit
- **THEN** 系统为两者之间的每个提交创建独立的评审任务

#### Scenario: 区间参数非法
- **WHEN** 用户输入 from >= to，或输入非正整数 SVN revision
- **THEN** 系统拒绝创建任务并返回明确的参数错误提示

### Requirement: 评审任务生命周期管理

系统 SHALL 对每个评审任务维护生命周期状态：排队（queued）、运行中（running）、成功（succeeded）、失败（failed）、取消（cancelled）。任务 SHALL 按仓库串行、跨仓库并行执行。用户 SHALL 能在 Web 控制台查看任务实时状态，并取消仍在排队或运行中的任务。

#### Scenario: 查看任务进度
- **WHEN** 评审任务正在运行
- **THEN** Web 控制台显示该任务的状态、开始时间以及运行时长，无需手动刷新即可更新

#### Scenario: 取消任务
- **WHEN** 用户对一个排队或运行中的任务点击"取消"
- **THEN** 任务状态变为"已取消"，其底层 `ocr` 进程被终止，不再产生结果

#### Scenario: 评审执行器失败
- **WHEN** `ocr` 进程执行失败（如 LLM API 不可达、仓库凭据失效）
- **THEN** 任务状态变为"失败"，失败原因中包含 `ocr` 的错误输出

### Requirement: 评审报告持久化

系统 SHALL 将每个评审任务的报告（含 `ocr` JSON 格式输出）持久化保存，任务结束后用户 SHALL 能随时回看。系统 SHALL 支持按节点号、上库人员、任务时间、任务状态检索历史报告。

#### Scenario: 回看历史报告
- **WHEN** 用户打开历史评审列表并点击某个已完成的任务
- **THEN** 系统展示该任务的完整评审报告，包括评审发现的问题及行级定位

#### Scenario: 按条件检索
- **WHEN** 用户按上库人员 "zhangsan" 过滤历史任务
- **THEN** 列表只显示该人员提交节点对应的评审任务

### Requirement: 重复评审防护

系统 SHALL 检测同一仓库同一节点是否已有未取消的评审记录，用户手动重复触发时 SHALL 给出提示并要求确认，而不是静默创建重复任务。

#### Scenario: 重复触发提示
- **WHEN** 用户对已成功评审过的节点再次发起评审
- **THEN** 系统提示"该节点已有评审记录"，用户确认后才创建新任务

### Requirement: 评审完成后触发通知

评审任务到达终态（成功或失败）时，系统 SHALL 按已配置的通知触发规则发送结果通知（见 notifications 能力）。未配置任何渠道时 SHALL 静默跳过通知，不影响任务收尾。

#### Scenario: 任务完成触发通知
- **WHEN** 一个评审任务成功结束且通知规则配置为"全部完成"
- **THEN** 系统异步向已启用的邮件与聊天机器人渠道发送该任务的结果通知
