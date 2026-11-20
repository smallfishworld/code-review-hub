# Spec Delta

## Purpose

`memory.query` 是平台内置的记忆查询桥（stdio），不属于用户注册表面。注入器在满足条件时自动把它附加进任务的 MCP 注入，与用户注册的服务器共用同一门控、同一审计表；用户可通过同名注册记录显式停用。

## ADDED Requirements

### Requirement: 内置记忆查询桥的自动附加

评审任务满足以下全部条件时，注入器 SHALL 自动向该任务附加名为 `memory.query` 的内置 stdio MCP 服务器：(a) 引擎记忆注入能力非 none；(b) 引擎 MCP 能力为 config-inject 且未被运行时降级；(c) 注册表中不存在同名记录，或同名记录为启用状态。内置服务器的配置由注入器生成：启动命令为平台构建产物中的桥脚本（经 node 执行），并经环境变量提供数据目录与仓库标识。内置服务器 MUST 与用户注册服务器一样写入任务注入审计；其工具调用统计沿用引擎上报通道。用户创建同名停用记录 MUST 能关闭自动附加，且不影响其他服务器。自动附加 MUST NOT 修改用户注册表数据。

#### Scenario: 符合条件的任务自动获得记忆查询工具
- **WHEN** ocr 引擎（MCP config-inject、未被降级）执行一个存在记忆数据的仓库评审
- **THEN** 该任务的 ocr 配置含 `memory.query` 服务器（node + 桥脚本 + 仓库 env），任务注入审计包含该条目

#### Scenario: 用户显式停用内置桥
- **WHEN** 管理员在 MCP 注册表创建名为 `memory.query` 的停用记录
- **THEN** 后续任务的注入不再包含该服务器，其余 MCP 服务器注入不受影响

#### Scenario: MCP 降级时一并跳过
- **WHEN** 引擎运行时 MCP 能力被降级（如 ocr 版本不支持）
- **THEN** `memory.query` 与用户服务器一同被跳过，任务记录标注降级原因
