# mcp-integration Specification

## Purpose
平台统一管理 MCP（Model Context Protocol）服务器注册表，并在评审执行时把启用的 MCP 服务器注入评审引擎的配置，使评审智能体可以通过 MCP 工具（如 codegraph 符号检索）加速上下文获取。MCP 服务器配置等价于任意命令执行入口，因此注册、修改、测试 MUST 限于管理员，且调用行为 MUST 可审计。

## Requirements

### Requirement: MCP 服务器注册表

平台 SHALL 维护 MCP 服务器注册表，每条记录 MUST 包含：名称（唯一）、传输类型（stdio / http）、连接配置（stdio：command/args/env；http：url/headers）、启用状态、作用域（global 或绑定单个仓库）、工具白名单（可选）、超时秒数。名称与配置在保存时 MUST 做格式校验，非法配置不得保存。

#### Scenario: 注册 stdio MCP 服务器
- **WHEN** 管理员以 stdio 类型注册名为 codegraph 的服务器（command + args）
- **THEN** 注册表新增一条 enabled 记录，可在仓库或全局作用域被引用

#### Scenario: 非法配置拒绝保存
- **WHEN** 管理员提交缺少 command 的 stdio 类型配置，或缺少 url 的 http 类型配置
- **THEN** 保存被拒绝并提示缺失字段

### Requirement: 作用域与注入

评审任务执行时，平台 SHALL 收集对该任务生效的 MCP 服务器：作用域为 global 且启用的全部 + 绑定该任务仓库且启用的全部，并注入引擎配置。注入方式由引擎能力决定：声明 config-inject 的引擎（ocr）MUST 通过其隔离 HOME 配置文件的 MCP 段注入；声明 none 的引擎 MUST 忽略注册表且任务不受影响。注入 MUST 与并发任务隔离：并行执行的评审 MUST NOT 互相覆盖注入配置，任何任务 MUST NOT 被注入其仓库未绑定的服务器。引擎运行时不具备 MCP 注入能力时（如 ocr 版本低于 1.13），平台 MUST 跳过注入、任务正常执行，并在任务记录中写明降级原因。

工具白名单非空时，平台 MUST 尽力强制：引擎支持按工具过滤时 MUST 仅放行列出的工具；引擎不支持时 MUST 注入完整服务器并在任务记录与控制台标注「白名单未强制执行」。

#### Scenario: 仓库绑定注入 ocr
- **WHEN** 仓库 R 绑定了启用的 codegraph（stdio）服务器，R 的评审任务由 ocr 引擎执行
- **THEN** 该次评审运行在其仓库隔离的 HOME 配置中包含 codegraph 的 mcp_servers 条目，评审完成后任务记录可查该注入

#### Scenario: 不支持 MCP 的引擎
- **WHEN** 注册表存在启用的服务器，但任务使用的引擎 MCP 能力为 none
- **THEN** 评审正常执行，不注入任何 MCP 配置，任务详情不展示 MCP 统计

#### Scenario: 并发任务注入隔离
- **WHEN** 仓库 R1（绑定 MCP 服务器 A）与仓库 R2（未绑定任何服务器）的评审任务并行执行
- **THEN** R2 的评审配置中不含服务器 A，两任务的注入互不影响

#### Scenario: 引擎版本过低降级
- **WHEN** 任务的引擎运行时版本低于 MCP 注入所需最低版本
- **THEN** 评审跳过 MCP 注入正常执行，任务记录标注降级原因

### Requirement: 连通性测试

平台 SHALL 提供 MCP 连通性测试：对 stdio 服务器启动进程完成 MCP initialize 握手并枚举 tools/list；对 http 服务器按 Streamable HTTP 语义（Accept 同时声明 application/json 与 text/event-stream）发起 initialize，成功后同样枚举 tools/list。测试结果 MUST 展示握手成功/失败与工具清单；initialize 成功而 tools/list 失败时 MUST 区分标注。超时使用记录的 timeout_sec。测试 MUST 不改动注册表数据。

#### Scenario: 测试成功
- **WHEN** 管理员对配置正确的 stdio 或 http 服务器点击测试
- **THEN** 展示握手成功与工具名称列表

#### Scenario: 测试失败
- **WHEN** command 不存在或进程在超时内未完成握手
- **THEN** 展示失败原因（启动失败 / 超时 / 协议错误），不产生部分写入

### Requirement: 调用审计

每次评审任务 MUST 持久化记录其 MCP 使用情况：注入了哪些服务器、各服务器的工具白名单是否被强制，为必记录项；评审过程中各工具的调用次数与失败次数在引擎输出包含该统计时 MUST 采集，引擎未上报时 MUST 在任务记录标注「引擎未上报工具统计」。审计记录 SHALL 在任务详情查看，且 MUST 不依赖运行日志的滚动保留（落库存储）。平台自身的常规 API 访问日志不要求覆盖 MCP 进程内部行为。

#### Scenario: 任务详情展示 MCP 统计
- **WHEN** 一次注入了 MCP 的评审完成且引擎输出包含工具调用统计
- **THEN** 任务详情展示各工具调用次数与失败次数

#### Scenario: 引擎未上报统计
- **WHEN** 一次注入了 MCP 的评审完成，但引擎输出不含工具调用统计
- **THEN** 任务详情展示注入服务器清单与「引擎未上报工具统计」标注

### Requirement: 管理员权限边界

MCP 注册表的创建、修改、删除、启停、测试 MUST 仅限已登录管理员；非管理员请求 MUST 被拒绝。控制台 MCP 页面 SHALL 明示风险提示（MCP 服务器以当前服务账号权限执行任意命令，仅应添加可信来源）。评审执行进程意外失败时，MCP 注入信息 MUST 仍保留在任务记录中以便排障。连接配置可能包含敏感值（http headers、stdio env 中的凭据）：API 与控制台回显配置时 MUST 对敏感字段值脱敏（保留键名），完整值仅用于注入与连通性测试。

#### Scenario: 非管理员拒绝
- **WHEN** 未登录会话请求修改 MCP 服务器
- **THEN** 返回未授权错误，注册表不变

#### Scenario: 风险提示展示
- **WHEN** 管理员打开 MCP 服务器管理页
- **THEN** 页面展示任意命令执行风险说明

#### Scenario: 敏感配置脱敏
- **WHEN** 管理员查看一个 headers 含 Authorization 的 http 服务器记录
- **THEN** 列表与详情接口返回脱敏后的值（保留键名），评审注入仍使用完整值

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
