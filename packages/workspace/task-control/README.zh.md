---
description: "持久化按项目串行的命令中心任务记录、批准、恢复和取消状态。"
kind: "package-reference"
---
# Task Control

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-task-control` 在执行器进程外记录明确的项目 allowlist 和命令中心任务，拒绝重叠的已批准目录，串行化路径重叠的任务，将批准绑定到执行器启动和精确 staging 更改，并在重启后如实报告未完成的执行或应用工作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在任务执行器或命令界面之前，将本包与存储提供方一起挂载。`registerProject()` 将规范化文件夹记录为明确批准，并拒绝与另一个批准存在父子路径重叠；此 allowlist 之外的共享 workspace 不能接收命令中心任务。`TaskControl` 拥有任务创建、批准消耗、生命周期转换、重启恢复和持久 Discord 终止交付标记。

`recordCopy()` 将已批准且运行中的任务绑定到一个私有快照根目录、规范化原项目目录以及精确的清单 SHA-256。`recordChanges()` 随后绑定完整的运行后更改集 digest；空更改集会记录为 `no-change`，不会进入审查或应用。只有仪表板决定指定非空更改 digest 时，`beginApply()` 才会消耗该决定，`finishApply()` 记录结果。重启会把进行中的应用变为 `apply-interrupted` 以供手动检查；它绝不重试文件系统操作。`recordExecutionError()` 持久记录清理失败详情，而不会将运行中或取消中的任务变为终止状态。

<a id="model-experience"></a>
## 模型体验

无，因为持久化任务记录不会进入模型请求。

#### KV Cache 影响

无直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 任务记录保留有界的脱敏诊断，而非完整执行器记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布运行时不变量 companion；domain schema 和单一任务服务负责所有持久转换，因此不存在可供比较的独立同进程 authority。

</details>
