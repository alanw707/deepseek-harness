---
description: "在项目工作区中以执行器专属限制和受管进程取消运行已批准的命令中心任务。"
kind: "package-reference"
---
# Task Execution

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-task-execution` 在仪表板批准后，于私有项目副本中启动一个独立的 Pi、Codex 或 OpenClaw 任务，保留有界安全诊断，派生可精确审查的更改，仅在原项目仍匹配基线时应用仪表板批准的 digest，并拥有取消过程而不会附着到现有执行器会话。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在本包之前挂载任务控制和沙箱提供方；通过所属 profile 配置执行器和 Docker CLI 路径、已存在且包含条目数和字节数限制的私有 `copies.directory`、`reviewLimitBytes` 以及隔离的 OpenClaw 配置。任务保持待处理，直到仪表板记录批准，并且每次运行只消耗一次批准。Pi 通过 `pi auth check --no-refresh --credentials --json` 读取缓存的 OpenAI Codex bearer，并通过临时 provider override 接收它；认证不可用或已过期时，任务失败，不刷新永久凭据。Codex 对配置的 auth 源进行不含 refresh token 的 staging，再将其复制到 sandbox 临时区域下的可写逐次运行 `CODEX_HOME`，因此运行无法轮换永久 Codex 凭据；staging 凭据值会从捕获输出中脱敏。Pi 对所需运行时状态使用相同的临时区域模式，而其文件工具拒绝副本工作区之外的所有路径。

终止结算会等待进程树退出和运行时清理，然后在 `reviewLimitBytes` 范围内记录完整 UTF-8 前后内容及目录 mode 的 digest。`review()` 验证保留文件仍匹配该 digest。`apply()` 持久消耗对所显示 digest 的批准，串行化所有应用尝试，拒绝已变化的原文件，并在后续操作失败时回滚已完成条目。服务释放会等待应用达到静止状态。清理失败会保留非终止任务及持久错误详情；明确请求取消会重试清理。

<a id="model-experience"></a>
## 模型体验

间接。本包启动外部代理；每个选定执行器拥有其模型请求和凭据。

#### KV Cache 影响

没有直接 DSH 模型请求影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 副本准备和审查后应用需要 Linux；执行器集合为 Pi、Codex 和 OpenClaw。
- 审查后应用接受有界 UTF-8 常规文件和目录。它拒绝二进制更改、文件/目录类型替换、已变化的原文件以及替换具有多个硬链接的文件。
- 应用期间的进程丢失会报告为 `apply-interrupted` 并要求手动检查项目；它绝不会自动重试。
- OpenClaw 任务执行需要单独管理且不含逐 agent `entries` 或旧版 `list` 的隔离配置文件；其 Docker 用户必须以 `uid:gid` 匹配 host 用户，其 sandbox 工具 allowlist 必须恰好包含 `group:fs` 和 `group:runtime`，额外的 bind mount 会被拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`prepareTaskCopy()` 通过相对目录描述符的读取，准备仅支持 Linux 的私有工作目录和基线目录。它拒绝符号链接和特殊文件，使副本与源文件的硬链接 inode 分离，限制遍历条目数和字节数，记录被排除的凭据及配置名称，并在失败或取消时删除未完成的副本。`TaskExecution.run()` 在副本工作区中启动之前，将其清单指纹绑定到持久任务。外层 sandbox 向该工作区及其后端临时区域授予写入权限；原项目、不可变基线、清单和凭据输入保持只读。Pi 和 Codex 通过只读 launcher 在临时区域下创建可写逐次运行 home，并在结束后删除全部 host staging。Codex 使用命名文件系统权限和可选的 `runtimeReadRoots`，禁止读取原项目、私有快照和运行时，也禁止子进程联网。OpenClaw 的受保护 launcher 删除由精确工作区 mount 选择的 Docker 容器，再于派生精确更改前删除生成的 `.openclaw` 状态。

不发布运行时不变量 companion；单一执行服务负责每个进程句柄直至持久 settle，生命周期测试覆盖进程与任务同步。

</details>
