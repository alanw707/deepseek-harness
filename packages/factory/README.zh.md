---
description: "本地 solo-factory 包组：持久化 issue 到 pull request 执行，以及启动或恢复它的面向模型工具。"
kind: "package-group"
---

# factory/ — 本地 issue 到 pull request 运行

[English](README.md) | 中文

## 概述

factory 组让一个开发者把 GitHub issue 交给本地 Harness agent，并得到隔离且保留的 worktree 或已打开的 pull request。库负责 Git worktree、阶段执行、历史、恢复、重复运行拒绝和 GitHub pull request 复用。Consumer 提供显式启动和恢复工具。此组没有任何包会 merge、release、调度或删除 worktree。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`solo-factory`](solo-factory/README.zh.md) | 无 shell 的实现、测试、审查和 pull request 流程，带持久本地历史 |
| [`tool-solo-factory`](tool-solo-factory/README.zh.md) | 面向模型的 `factory_run` 和 `factory_resume` Consumer |

可安装的 [`solo-factory` bundle](../bundle/solo-factory/README.zh.md) 将两个包组合进随附的 `headless-solo-factory` profile。

<a id="related-documentation"></a>
## 相关文档

- [Solo factory 子系统](../../docs/subsystems/solo-factory.zh.md) — 生命周期、持久化、并发和所有权。
- [Solo factory Agent Note](../../.agents/notes/implemented/feature/2026-09-03-solo-factory-run.zh.md) — 生命周期、持久化和人工关卡决策。
- [应用启动](../boot/app-boot/README.zh.md) — profile 组合和启动规则。
- [Bundle 目录](../bundle/README.zh.md) — 可安装的 profile 层。

<a id="dev-note"></a>
## 开发备注

无。
