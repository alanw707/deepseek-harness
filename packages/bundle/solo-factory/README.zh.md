---
description: "向 dsh profile 添加本地独立开发者 issue 到 pull request 工作流的面向模型启动和恢复工具。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-solo-factory-bundle

[English](README.md) | 中文

## 概述

此 bundle 向 profile 添加 `factory_run` 和 `factory_resume`，并为 solo factory 提供本地命令默认值。随附的 `headless-solo-factory` profile 将它与 headless 和 OAuth 支持的 Codex 层组合。设置一个仓库路径，手动调用 profile，并在前台运行结束时检查保留的 worktree 或已打开的 pull request。此层绝不 merge 或 release pull request。

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

### 安装到 profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-solo-factory-bundle
dsh plugin --profile <name> remove @deepseek-ai/dsh-solo-factory-bundle
```

内置 bundle 在 npm 回退前从 workspace 或安装目录解析。调和操作激活声明的 patch 层；没有 `dsh.bundle.patch` 的包不能作为层安装。

对于预组合路径，将 `DSH_FACTORY_REPOSITORY` 设为其 `origin/HEAD` 可用的绝对 checkout，认证 Harness Codex 和 `gh` CLI，然后手动启动任务：

```text
DSH_FACTORY_REPOSITORY=/absolute/path/to/repository dsh --profile headless-solo-factory "Run factory_run for GitHub issue 123 using its current title and body."
```

默认实现和审查命令运行嵌套 `headless-codex` agent。实现 prompt 负责规划、代码更改、聚焦检查、commit 和 push。独立测试命令通过 `--changed origin/HEAD` 运行 Vitest。PR 命令使用 `gh pr create` 和生成的分支。

使用 `DSH_FACTORY_WORKTREE_ROOT`、`DSH_FACTORY_HISTORY_FILE` 和 `DSH_FACTORY_BRANCH_PREFIX` 覆盖本地路径。使用 `DSH_FACTORY_IMPLEMENT`、`DSH_FACTORY_TEST`、`DSH_FACTORY_REVIEW` 或 `DSH_FACTORY_PR` 中的 JSON 覆盖各个完整命令向量。

### 获得的功能

- `factory_run` 在新的保留分支和 worktree 中启动一个 issue。
- `factory_resume` 重新运行已记录的失败阶段，然后运行其余未完成阶段。
- `dsh-solo-factory` 负责本地持久化、重复运行拒绝、PR 复用和 `pull-request-open` 终止状态。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 插入工具 Consumer，使用从 Harness home 派生的路径以及无 shell 的可执行文件/参数对象。[`src/index.ts`](src/index.ts) 不携带运行时行为。[`dsh-app-boot`](../../boot/app-boot/README.zh.md) 为 `headless-solo-factory` 在 base、headless 和 Codex 后组合此层。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Factory 包](../../factory/README.zh.md) — 库和 Consumer 的归属。
- [dsh app boot](../../boot/app-boot/README.zh.md) — profile 初始化和层顺序。
- [Bundle 目录](../README.zh.md) — 可用的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-solo-factory` 间接影响；后者拥有两个工具 schema 和结果文本。

#### KV Cache 影响

此 bundle 本身不改变 prompt 前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **本地已认证客户端** — 嵌套 agent 命令使用 Harness 所有的 OAuth；GitHub 操作使用 `gh` 凭据存储，因为名称形似凭据的环境变量不会被转发。
- **前台且手动** — 没有 webhook、scheduler、queue 或后台 worker 启动运行。
- **保留 worktree** — 用户手动检查并删除 worktree。
- **每个挂载层一个仓库** — 每个插件实例使用一个仓库和一个历史文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
