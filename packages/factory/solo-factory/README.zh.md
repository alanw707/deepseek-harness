---
description: "通过隔离的本地 worktree、agent 实现、验证、审查和 pull request 创建来运行一个 GitHub issue，并保存可恢复的 JSON 历史。"
kind: "package-library"
---

# @deepseek-ai/dsh-solo-factory

[English](README.md) | 中文

## 概述

`dsh-solo-factory` 将一个 issue 从已配置的 Git checkout 运行到已打开的 GitHub pull request。它保留生成的分支和 worktree，把每个已完成阶段记录在仅所有者可读的 JSON 文件中，并在命令失败后恢复而不重复已完成阶段。该库止于 pull request；仓库策略负责 merge 和 release。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 何时使用

从已经持有 issue id、标题和要求的 Cordis Consumer 或其他受信本地调用方使用此库。当 Harness agent 启动或恢复运行时，改用 [`tool-solo-factory`](../tool-solo-factory/README.zh.md) Consumer。

### 入口

```text
const factory = new SoloFactory(config)
const run = await factory.execute({ id, title, body })
const resumed = await factory.resume(runId)
```

`execute()` 从 `origin/HEAD` 创建分支，创建保留的 worktree，并在不使用 shell 的情况下运行已配置的实现、测试、审查和 pull request 命令。成功时返回带 `pullRequestUrl` 的 `pull-request-open`。已记录的失败会以 `FactoryRunError` 拒绝；其 `run` 携带 `resume()` 或检查所需的 id、`failedStage` 和 worktree。

历史文件使用格式版本 `0`。实验性数组格式的文件、格式错误的记录，或 worktree 不属于已配置 worktree 根目录的记录，会以 `unsupported solo factory history format` 失败。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

`SoloFactory` 使用共享 atomic-write 锁串行化历史更新，不同 issue 的运行则在独立 worktree 中并发执行。`LocalCommandRunner` 继承普通进程设置，但移除名称形似凭据的环境变量和 `DSH_*` 环境变量；已配置命令直接接收参数。创建 pull request 前，该库通过 `gh` 查询此分支已打开的 pull request，并在存在时复用它。

| 源码 | 用途 |
|---|---|
| [`src/index.ts`](src/index.ts) | 运行生命周期、历史验证、worktree 创建、命令执行和 GitHub PR 查询 |
| [`tests/solo-factory.spec.ts`](tests/solo-factory.spec.ts) | 真实临时 Git 行为和命令适配器覆盖 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`tool-solo-factory`](../tool-solo-factory/README.zh.md) — 面向模型的启动和恢复操作。
- [`solo-factory` bundle](../../bundle/solo-factory/README.zh.md) — 随附的 `headless-solo-factory` 组合。
- [Solo factory Agent Note](../../../.agents/notes/implemented/feature/2026-09-03-solo-factory-run.zh.md) — 生命周期与范围理由。

-----

<a id="model-experience"></a>
## 模型体验

无，因为该库不注册 prompt、tool 或模型上下文；已配置的实现和审查 profile 负责所有模型使用。

#### KV Cache 影响

这里没有任何内容进入调用方的请求前缀，因此不影响提供方缓存复用。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **仅记录的失败** — `resume()` 处理已拒绝并产生 `failed` 记录的命令；它不会在宿主突然停止后推断被中断的进程。
- **仅 GitHub pull request** — PR 恢复调用已认证的 `gh` CLI，并复用生成分支上已打开的 pull request。
- **手动清理** — 成功和失败的 worktree 都会保留，直到用户通过 Git 删除。
- **不 merge 或 release** — pull request 是人工关卡，也是 factory 的终止结果。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
