# Spec Delta

## Purpose

平台统一管理 MCP（Model Context Protocol）服务器注册表，并在评审执行时把启用的 MCP 服务器注入评审引擎的配置，使评审智能体可以通过 MCP 工具（如 codegraph 符号检索）加速上下文获取。MCP 服务器配置等价于任意命令执行入口，因此注册、修改、测试 MUST 限于管理员，且调用行为 MUST 可审计。

## ADDED Requirements

### Requirement: MCP 服务器注册表

平台 SHALL 维护 MCP 服务器注册表，每条记录 MUST 包含：名称（唯一）、传输类型（stdio / http）、连接配置（stdio：command/args/env；http：url/headers）、启用状态、作用域（global 或绑定单个仓库）、工具白名单（可选）、超时秒数。名称与配置在保存时 MUST 做格式校验，非法配置不得保存。

#### Scenario: 注册 stdio MCP 服务器
- **WHEN** 管理员以 stdio 类型注册名为 codegraph 的服务器（command + args）
- **THEN** 注册表新增一条 enabled 记录，可在仓库或全局作用域被引用

#### Scenario: 非法配置拒绝保存
- **WHEN** 管理员提交缺少 command 的 stdio 类型配置，或缺少 url 的 http 类型配置
- **THEN** 保存被拒绝并提示缺失字段

### Requirement: 作用域与注入

评审任务执行时，平台 SHALL 收集对该任务生效的 MCP 服务器：作用域为 global 且启用的全部 + 绑定该任务仓库且启用的全部，并注入引擎配置。注入方式由引擎能力决定：声明 config-inject 的引擎（ocr）MUST 通过其隔离 HOME 配置文件的 MCP 段注入；声明 none 的引擎 MUST 忽略注册表且任务不受影响。工具白名单非空时 MUST 生效（仅放行列出的工具）。

#### Scenario: 仓库绑定注入 ocr
- **WHEN** 仓库 R 绑定了启用的 codegraph（stdio）服务器，R 的评审任务由 ocr 引擎执行
- **THEN** 该次评审运行在隔离 HOME 配置中包含 codegraph 的 mcp_servers 条目，评审完成后审计日志记录该注入

#### Scenario: 不支持 MCP 的引擎
- **WHEN** 注册表存在启用的服务器，但任务使用的引擎 MCP 能力为 none
- **THEN** 评审正常执行，不注入任何 MCP 配置，任务详情不展示 MCP 统计

### Requirement: 连通性测试

平台 SHALL 提供 MCP 连通性测试：对 stdio 服务器启动进程完成 MCP initialize 握手并枚举 tools/list，对 http 服务器发起 initialize 请求；测试结果 MUST 展示握手成功/失败与工具清单，超时使用记录的 timeout_sec。测试 MUST 不改动注册表数据。

#### Scenario: 测试成功
- **WHEN** 管理员对配置正确的 stdio 服务器点击测试
- **THEN** 展示握手成功与工具名称列表

#### Scenario: 测试失败
- **WHEN** command 不存在或进程在超时内未完成握手
- **THEN** 展示失败原因（启动失败 / 超时 / 协议错误），不产生部分写入

### Requirement: 调用审计

每次评审任务 MUST 记录其 MCP 使用情况：注入了哪些服务器、评审过程中各工具的调用次数与失败次数（引擎输出含该统计时直接采集）。审计记录 SHALL 可在任务详情查看。平台自身的常规 API 访问日志不要求覆盖 MCP 进程内部行为。

#### Scenario: 任务详情展示 MCP 统计
- **WHEN** 一次注入了 MCP 的评审完成且引擎输出包含工具调用统计
- **THEN** 任务详情展示各工具调用次数与失败次数

### Requirement: 管理员权限边界

MCP 注册表的创建、修改、删除、启停、测试 MUST 仅限已登录管理员；非管理员请求 MUST 被拒绝。控制台 MCP 页面 SHALL 明示风险提示（MCP 服务器以当前服务账号权限执行任意命令，仅应添加可信来源）。评审执行进程意外失败时，MCP 注入信息 MUST 仍保留在任务记录中以便排障。

#### Scenario: 非管理员拒绝
- **WHEN** 未登录会话请求修改 MCP 服务器
- **THEN** 返回未授权错误，注册表不变

#### Scenario: 风险提示展示
- **WHEN** 管理员打开 MCP 服务器管理页
- **THEN** 页面展示任意命令执行风险说明
