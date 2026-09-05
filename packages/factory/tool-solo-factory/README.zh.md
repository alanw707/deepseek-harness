---
description: "让 Harness agent 启动或恢复已配置的独立开发者 issue 到 pull request 运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-solo-factory

[English](README.md) | 中文

## 概述

`dsh-tool-solo-factory` 为 Harness agent 提供显式操作，以启动一个 issue 或恢复一个失败的运行。启动操作接收 issue 标识和要求；两个操作都会等待本地 factory，并返回运行 id、终止状态，以及 pull request URL 或保留的 worktree。该包不 merge、不 release、不调度，也不删除 worktree。

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

通过 [`headless-solo-factory`](../../bundle/solo-factory/README.zh.md) 挂载此包，这是受支持的应用启动路径。直接自定义组合必须提供所有路径和命令向量。

### 何时选择

当现有 Harness agent 应通过面向模型的工具启动前台 factory 流程时，选择此包。对于不需要模型可见工具的受信程序调用方，直接使用 [`dsh-solo-factory`](../solo-factory/README.zh.md)。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-tool-solo-factory'
  config:
    repository: /absolute/path/to/repository
    worktreeRoot: /private/path/to/worktrees
    historyFile: /private/path/to/runs.json
    branchPrefix: factory
    implement:
      executable: dsh
      args: [--profile, headless-codex, 'Plan and implement GitHub issue #{issue}: {title}. Requirements: {body} Run focused tests, commit the changes, and push branch {branch}.']
    test:
      executable: pnpm
      args: [exec, vitest, run, --changed, origin/HEAD]
    review:
      executable: dsh
      args: [--profile, headless-codex, 'Review branch {branch} against origin/HEAD for repository standards and GitHub issue #{issue}: {title}. Requirements: {body} Fix valid findings, run focused checks, commit, and push.']
    pullRequest:
      executable: gh
      args: [pr, create, --head, '{branch}', --title, '{title}', --body, '{body}']
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `repository` | 必填 | 每次运行从其 `origin/HEAD` 开始的 Git checkout |
| `worktreeRoot` | 必填 | 保存保留 worktree 的私有目录 |
| `historyFile` | 必填 | 仅所有者可读的带版本 JSON 历史 |
| `branchPrefix` | 必填 | 生成分支的命名空间 |
| `implement` | 必填 | 规划、实现、聚焦检查、commit 和 push 命令 |
| `test` | 必填 | 仓库验证命令 |
| `review` | 必填 | 分支审查命令 |
| `pullRequest` | 必填 | GitHub pull request 创建命令 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-solo-factory)是所有已接受字段的完整来源。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

该插件构造一个 `SoloFactory`，并注册 `factory_run` 和 `factory_resume`。库负责执行和持久化；此 Consumer 只负责面向模型的 schema 和简洁结果文本。

| 源码 | 用途 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置验证和工具注册 |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | 真实 Loader 组合和模型可见 schema 覆盖 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [`dsh-solo-factory`](../solo-factory/README.zh.md) — 运行生命周期和本地历史。
- [`solo-factory` bundle](../../bundle/solo-factory/README.zh.md) — 随附的 profile 默认值。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 注册和执行行为。

-----

<a id="model-experience"></a>
## 模型体验

### Factory 工具

#### 模型看到什么

模型收到生成的 [`factory_run` 和 `factory_resume` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-solo-factory)。结果标识持久运行，并在成功时报告状态和 pull request URL，在成功前报告保留的 worktree。已记录的阶段失败会把 `failed`、失败阶段、运行 id 和 worktree 作为普通工具结果返回，使模型能够调用 `factory_resume`；没有持久失败运行的配置和验证错误仍会拒绝。

#### Token 影响

两个稳定工具 schema 增加固定的请求成本。

#### KV Cache 影响

只要插件配置和工具定义不变，就保持稳定。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **前台执行** — 每个工具调用保持打开，直到运行成功或命令记录失败。
- **受信配置** — 工具参数不能替换命令向量或存储路径。
- **无历史列表工具** — 调用方保留失败运行 id 供 `factory_resume` 使用，或在模型之外检查仅所有者可读的历史文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
