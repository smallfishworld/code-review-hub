# Spec Delta

## Purpose

让评审 agent 在 agent 循环中按需查询项目记忆，弥补评审前一次性注入（1500 token 预算）的截断盲区。桥为只读 stdio MCP 进程，与预注入通道互补；写入仍只走蒸馏 / 反馈治理管线。

## ADDED Requirements

### Requirement: 记忆查询 MCP 桥

平台 SHALL 提供只读的记忆查询 MCP 桥进程（stdio），在评审时由注入器自动提供给支持 MCP 的引擎。桥 MUST 仅暴露三个只读工具：`memory_search`（按查询词召回，可按记忆类型过滤，返回条数有上限）、`memory_get`（按 id 取单条全文与来源任务）、`memory_stats`(该仓库记忆统计)。桥 MUST 以只读方式打开平台 SQLite（WAL 多进程读），且其可见范围 MUST 被强制限定在单一仓库（由注入器经环境变量提供，工具参数不接受仓库标识）。桥 MUST 复用与预注入一致的召回与排序逻辑（置信度 × 新近度 × 命中，低置信度门槛），输出 MUST 有长度上限。桥进程故障或记忆库不可用 MUST NOT 影响评审任务本身（工具返回明确错误文案）。

#### Scenario: agent 按需查询误报历史
- **WHEN** 评审 agent 在循环中调用 `memory_search`，query 命中该仓库某条 suppression 记忆
- **THEN** 工具返回该条目的标题、正文（人工写的误报原因）、置信度与来源任务链接，ocr 的 MCP 循环正常把结果送回模型

#### Scenario: 仓库隔离不可跨越
- **WHEN** agent 尝试用另一仓库的记忆 id 调用 `memory_get`
- **THEN** 返回未找到，且任何工具在任何参数下都不会返回其他仓库的条目

#### Scenario: 记忆库不可用时评审不受影响
- **WHEN** 桥无法只读打开数据库（文件缺失 / 锁超时）或桥进程崩溃
- **THEN** 工具返回明确的不可用文案（或该 MCP 服务器不可用），评审任务照常完成，报告与通知不变

#### Scenario: 输出有界
- **WHEN** `memory_search` 命中大量条目或单条正文超长
- **THEN** 返回条数不超过上限（默认 5，最大 10），单条正文被截断到上限长度
