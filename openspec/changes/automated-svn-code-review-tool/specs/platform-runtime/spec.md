# Spec Delta

## Purpose

定义平台的部署与运行能力：在 Linux 与 Windows 上运行、配置与数据持久化、服务启动方式，以及对 `svn` 与 `ocr` CLI 外部依赖的检测。

## ADDED Requirements

### Requirement: 跨平台运行

系统 SHALL 能在 Linux 和 Windows 上以相同代码运行，所有文件路径处理、进程调用、子进程环境 SHALL 兼容两个平台，不依赖平台特有的 shell 特性。

#### Scenario: Windows 部署
- **WHEN** 平台部署在 Windows Server 上，配置了 SVN 仓库并触发评审
- **THEN** 评审任务正常执行并产出报告

#### Scenario: Linux 部署
- **WHEN** 平台部署在 Linux 服务器上，执行与 Windows 相同的操作
- **THEN** 行为一致，评审任务正常执行并产出报告

### Requirement: 外部依赖检测

服务启动时 SHALL 检测 `svn`、`git` 与 `ocr` 三个命令是否可用；缺失任一依赖时 SHALL 启动失败或在控制台与 Web 界面明确标示缺失项及安装指引，其中 `svn` 与 `git` SHALL 标示为"按所用仓库类型条件需要"（平台未配置该类型仓库时缺失不阻塞评审功能）。Web 控制台 SHALL 展示当前依赖的版本信息。

#### Scenario: 缺少 ocr 命令
- **WHEN** 服务启动时 PATH 中找不到 `ocr` 命令
- **THEN** 界面显示依赖缺失告警，说明需要安装 @smallfishworld/open-code-review-svn，且触发评审的任务立即失败并给出同样原因

#### Scenario: 缺少 git 命令
- **WHEN** 服务启动时 `git` 不可用且平台配置了 Git 类型仓库
- **THEN** 界面显示明确告警，Git 仓库的监控与评审任务失败并给出原因

#### Scenario: 正常检测
- **WHEN** 所需命令均可执行
- **THEN** 系统在界面上显示其版本号，对应类型仓库的评审功能可用

### Requirement: 配置与数据持久化

系统 SHALL 将仓库配置、凭据、Provider 配置、监控规则、任务与报告持久化到本地存储（数据库与文件），除用户主动删除外不丢失；所有配置 SHALL 通过 Web 界面或配置文件管理，不需要修改代码。

#### Scenario: 重启后配置保留
- **WHEN** 服务重启
- **THEN** 所有仓库、Provider、监控规则及历史任务与报告仍然可用

### Requirement: 服务运行方式

系统 SHALL 提供单一服务进程启动方式（如 `npm start` 或等价命令），Web 服务、任务执行器、监控器在同一进程内运行；SHALL 提供日志输出用于排查运行问题。

#### Scenario: 启动服务
- **WHEN** 运维人员在服务器上执行启动命令
- **THEN** 服务监听配置的端口，Web 控制台可访问，监控器按规则自动开始轮询

#### Scenario: 查看运行日志
- **WHEN** 运维人员需要排查一次失败的评审
- **THEN** 服务日志中包含该任务的执行记录、`ocr` 进程退出码与错误输出摘要
