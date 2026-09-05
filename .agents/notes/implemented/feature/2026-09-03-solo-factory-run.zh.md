# Agent Note: Solo factory run

Status: implemented

[English](2026-09-03-solo-factory-run.md) | 中文

## Problem
独立开发者需要一条从 GitHub issue 到隔离实现和已打开 pull request 的持久路径，而不必手工协调 worktree、重复 agent 调用、验证、审查和失败恢复。该路径不能把 pull request 变成自动批准、merge 或 release 机制。

## Decision
`@deepseek-ai/dsh-solo-factory` 负责一个本地 issue 到 pull request 运行。已配置的运行从 `origin/HEAD` 创建分支，创建并保留隔离的 Git worktree，然后执行无 shell 的命令向量，依次完成实现、聚焦测试、审查和 pull request 创建。实现和审查向量可以运行独立的 `headless-codex` agent；被调用的 profile 负责自己的 Session 日志。

持久状态词汇为 `accepted`、`workspace-ready`、`implemented`、`tested`、`reviewed`、`pull-request-open` 和 `failed`。成功运行终止于 `pull-request-open` 并存储规范 GitHub URL。任何 factory 包都不暴露 merge 或 release 行为。

历史文件是仅所有者可读、原子替换的 `{ formatVersion: 0, runs }` 文档。每个转换存储时间戳；每次命令尝试存储无 shell 命令、开始和结束时间戳、成功或失败、请求捕获时的有界输出，以及失败文本。loader 验证每条记录，并验证每个已存储 worktree 都是已配置 worktree 根目录下对应分支的预期子目录。实验性数组历史和任何未来版本都会以 `unsupported solo factory history format` 失败；此预发布格式没有迁移路径。

文件锁串行化历史修改和重复检测。不同 issue 的运行可以在独立 worktree 中进行，而同一仓库和 issue 的第二个活跃运行会被拒绝。`resume(runId)` 只接受失败运行，重新运行已记录的失败阶段，并继续后续未完成阶段，不重复已完成命令。Pull request 恢复会先通过 `gh pr list` 查询该分支上已打开的 pull request，因此恢复失败的 PR 阶段会复用现有 pull request，而不是创建重复项。

`@deepseek-ai/dsh-tool-solo-factory` 提供固定的 `factory_run` 和 `factory_resume` Consumer。持久化的阶段失败会返回面向模型的 `failed` 结果，其中包含失败阶段、运行 id 和 worktree，因此同一调用方无需读取私有历史文件即可调用 `factory_resume`。可安装的 solo-factory bundle 提供本地 `dsh`、`pnpm` 和 `gh` 命令默认值。随附的 `headless-solo-factory` profile 组合 base、headless、Codex 和 solo-factory 层，并且只通过 `dsh --profile` 启动。

子命令接收经过清理的环境，其中移除名称形似凭据的变量和 `DSH_*` 变量。因此，Harness OAuth 和 `gh` 凭据存储是受支持的认证路径，而不是转发环境中的秘密。

## Alternatives considered

**企业编排平面。** 租户身份、治理策略、批准服务、dashboard、webhook、queue、release 自动化和合规记录会为单开发者工作流增加无关的操作者和失败模式。这些能力不存在；仓库审查策略仍是权威。

**审查后自动 merge 和 release。** 自动审查是建议性的，不能代替人工 pull request 关卡。以已打开 pull request 为终点，可让批准、merge、部署和 release 策略继续归 GitHub 和仓库现有流程所有。

**仅使用 workflow 脚本。** `dsh-workflow` 可以协调 subagent，但不负责 Git worktree 隔离、跨进程持久运行历史、重复 issue 检测或 GitHub pull request 恢复。

**GitHub webhook 流程。** 自动接入会引入 webhook 凭据、重试、后台执行和 queue 语义。手动调用足以满足一个开发者的需要，并使启动决策保持显式。

**手工使用 worktree 与 `gh`。** 现有命令仍是有用的逃生路径，但它们本身不提供已验证的运行记录、失败阶段恢复或重复 pull request 防护。

## Consequences

开发者获得一个手动命令界面、保留的隔离环境、可检查的仅所有者状态、可恢复的已记录命令失败，以及作为交接的 pull request URL。聚焦测试使用真实临时 Git 仓库、假的命令适配器和真实 Loader 组合，以固定 worktree、历史、恢复、重复运行、工具 schema、bundle 和 profile 行为。

运行保持为前台操作。宿主突然停止可能留下非失败的活跃记录，需要手动检查，而不是推断式恢复。Worktree 永远不会自动删除。GitHub 访问需要已认证的 `gh` 凭据存储，嵌套 agent 需要 Harness 所有的 OAuth，仓库仍负责 branch protection、required check、审查批准、merge、部署和 release。
