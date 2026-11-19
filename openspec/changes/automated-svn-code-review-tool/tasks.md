# Tasks

## 1. 项目脚手架与依赖检测

- [x] 1.1 初始化 monorepo 结构（`server/`、`web/`），配置 TypeScript、ESLint、Vitest，`npm run dev` / `npm run build` / `npm test` 可用
- [x] 1.2 实现启动依赖检测模块（`svn` / `git` / `ocr` 三命令探测，跨平台 PATH 查找，svn/git 标示为按仓库类型条件需要），服务启动时输出检测报告，单测覆盖存在/缺失/不可执行三种情况
- [x] 1.3 集成 SQLite（better-sqlite3），建立数据库迁移机制与 `repo/credential/provider/monitor_rule/monitor_state/task/report/notification_channel/notification_log` 表结构（repo 表含 type 字段：svn|git），重启后数据保留验证通过

## 2. 仓库与凭据层（SVN + Git）

- [x] 2.1 实现 `svn` 命令封装（`svn info` / `svn log --xml` / `svn update` 子进程调用，跨平台无 shell 特性），XML 输出解析有单测（含作者、changed paths、中文路径）
- [x] 2.2 实现 `git` 命令封装（clone/fetch/checkout/log/ls-remote，凭据注入不改全局配置），`git log` 解析（作者、变更文件、时间）单测通过
- [x] 2.3 实现仓库配置增删改查 API（type=svn|git，保存前连通性验证：svn info / git ls-remote，失败不保存；删除提示影响范围并保留历史报告），集成测试覆盖成功/凭据错误/不可达三种场景
- [x] 2.4 实现凭据加密存储（AES-256-GCM + 本地 keyfile）与回显脱敏，单测验证密文落库、明文不出现在 API 响应中

## 3. 评审任务执行器（review-execution）

- [x] 3.1 实现持久化任务表 + 进程内 worker 队列：每仓库串行、跨仓库并行，状态机 queued/running/succeeded/failed/cancelled，崩溃恢复（重启时 running→failed、queued 重新入队），用假 `ocr` 脚本做集成测试验证状态流转与恢复
- [x] 3.2 实现 `ocr` 调用器：SVN 任务先 `svn update -r <rev>` 工作副本再跑 `ocr review --repo <wc> --commit <rev> --format json --output <file>`；Git 任务先 `git fetch + checkout <sha>` 再跑 `ocr review --repo <repo> --commit <sha>`；退出码/错误输出采集，取消任务时终止子进程——stub 测试验证成功/失败/取消路径
- [x] 3.3 实现报告解析与存储：`ocr` JSON 原文存 `data/reports/<task-id>.json`，问题摘要（文件/行号/级别/描述）入库；解析失败时保留原文并标记 succeeded-but-raw，针对真实 `ocr` 输出样本（SVN 与 Git 各一份）写解析单测
- [x] 3.4 实现手动触发 API：SVN 单 revision / Git 单 commit（短哈希解析与唯一性校验）/ 双类型区间（svn log、git log --reverse 拆分为逐节点任务，含参数校验、重复评审确认、大区间确认提示），集成测试覆盖非法参数、重复触发、区间拆分三种情况
- [x] 3.5 实现任务查询 API：列表过滤（节点号、作者、状态、触发方式、仓库）与详情读取（DB 索引 + 原文文件），针对过滤条件组合写测试
- [x] 3.6 实现任务终态完成事件钩子（succeeded/failed 时发出事件），为通知子系统提供接入点，单测验证事件按终态触发

## 4. 上库监控（revision-monitoring）

- [x] 4.1 实现 SVN 轮询器：`svn log --xml -r (last+1):HEAD` 增量识别新节点，首次启用默认从 HEAD 起点（可选回溯 N 个节点），处理位置持久化、SVN 不可达时记录失败并继续下轮，用本地测试 SVN 仓库验证起点、补节点与断线恢复
- [x] 4.2 实现 Git 轮询器：`git fetch` 后 `git log --reverse <last>..<origin/<branch>>` 增量识别新提交，大仓库首次克隆后台执行并显示初始化状态，验证逻辑同 4.1
- [x] 4.3 实现过滤引擎：人员白名单 + 路径前缀列表（同时配置为 AND 语义），命中建任务、未命中写跳过日志（含原因），过滤逻辑单测覆盖命中/未命中/组合三种情况（SVN 与 Git 节点各测）
- [x] 4.4 实现监控规则启停与去重（同 repo+节点不重复建任务），验证：停用后不再轮询、服务重启后从持久化位置继续、重复轮询不重复建任务

## 5. LLM Provider 配置

- [x] 5.1 实现 Provider 配置 API（API 地址/Key/模型名，Key 加密存储与脱敏回显）与连通性测试端点，测试覆盖保存、脱敏回显、连接失败返回具体原因

## 6. 通知子系统（notifications）

- [x] 6.1 实现渠道抽象与配置 API：`notification_channel` 表（email|chat）、渠道启停、凭据加密存储与脱敏回显、全局触发规则（全部完成/仅失败/仅成功），测试覆盖 CRUD、脱敏、触发规则解析
- [x] 6.2 实现邮件渠道：nodemailer SMTP 发送（配置加密存储）、HTML/文本正文渲染、测试发送端点，集成测试用本地 SMTP stub 验证成功与失败原因回传
- [x] 6.3 实现聊天机器人渠道：webhook POST（可配自定义 header 凭据），模板引擎支持 `{{repo}} {{node}} {{author}} {{status}} {{summary}} {{report_url}}` 占位符，支持纯文本与整包 JSON 两种模板（JSON 模板渲染后 parse 校验），测试发送端点，单测覆盖两种模板渲染与占位符替换
- [x] 6.4 实现通知发送器：消费任务终态事件、按触发规则过滤、异步发送 + 有限重试（3 次退避）、失败写 `notification_log`（渠道/任务/原因），单测验证失败隔离（任务状态不受影响）与重试耗尽后停止

## 7. Web 控制台（web-console）

- [x] 7.1 搭建前端框架（React + Vite + 路由 + API 客户端），登录页与管理员口令校验（鉴权做成可替换接口层），验证未登录访问配置页被拦截
- [x] 7.2 仓库管理页：SVN/Git 类型切换表单、列表、增删改（保存时连通性验证反馈）、删除确认（影响范围提示），手动走通两种类型仓库的增删改启停
- [x] 7.3 监控规则页：每仓库规则编辑（间隔、人员白名单、路径列表、Git 监控分支、回溯 N 节点，带输入校验）、启停开关、监控状态面板（最近轮询时间、最新节点、已处理位置、触发/跳过记录、Git 克隆初始化进度），手动验证校验与状态展示
- [x] 7.4 手动触发页与任务列表页：SVN/Git 双类型单节点/区间表单、任务列表过滤（状态/作者/触发方式/仓库类型）、任务详情（报告问题列表：文件/行号/描述），端到端走通一次手动触发→排队→完成→查看报告
- [x] 7.5 Provider 配置页：表单、测试连接按钮、Key 脱敏展示，手动验证
- [x] 7.6 通知配置页：邮件与聊天机器人渠道表单（凭据脱敏）、模板编辑与占位符说明、触发规则选择、发送测试按钮、通知日志列表，手动验证测试发送与日志展示

## 8. 系统集成验证与文档

- [x] 8.1 端到端集成验证（依赖真实 `ocr` + 测试 SVN 与 Git 仓库）：SVN/Git 手动单节点与区间评审、自动监控触发（含人员/路径过滤命中与跳过、首次启用起点）、通知触发（成功/失败/仅失败规则，邮件 + 聊天机器人渠道）、服务重启恢复，全部按 spec 场景走通并记录结果
- [x] 8.2 编写部署文档（README）：Linux 与 Windows 安装步骤、依赖要求（svn/git/ocr/Node）、`npm start` 启动、配置初始管理员口令、通知渠道对接指引（含企业聊天软件 webhook 模板示例），按文档在两个平台各跑通一次启动
- [x] 8.3 跨平台冒烟验证：在 Windows 与 Linux 各完成"启动→配置 SVN 与 Git 仓库→触发一次评审→收到通知→查看报告"全流程，确认无平台差异问题

## Workflow follow-up

- 归档本 change（`openspec-archive-change`）前，确认 5 个 capability 的 spec 场景均有对应验证。
- 上线后观察监控轮询稳定性，若需要即时性再评估 post-commit/push hook 方案。
- 若未来确定唯一聊天平台，可基于通用 webhook 模板沉淀该平台预置模板。
