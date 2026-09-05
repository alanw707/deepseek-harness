# Solo factory

[English](solo-factory.md) | 中文

Solo factory 将一个手动提供的 GitHub issue 转换为隔离的本地运行，并终止于已打开的 pull request。[`@deepseek-ai/dsh-solo-factory`](../../packages/factory/solo-factory/README.zh.md) 负责执行和持久化，[`@deepseek-ai/dsh-tool-solo-factory`](../../packages/factory/tool-solo-factory/README.zh.md) 负责面向模型的启动和恢复操作，[bundle](../../packages/bundle/solo-factory/README.zh.md) 提供随附的 `headless-solo-factory` 组合。Pull request 是唯一人工关卡；merge、release、调度、接入和清理都在此子系统之外。

## 运行生命周期

新运行接收 issue id、标题和正文。它从 `origin/HEAD` 创建唯一分支和保留的 worktree，然后按顺序执行以下阶段：

| 阶段 | 成功持久状态 | 操作 |
|---|---|---|
| Workspace | `workspace-ready` | 获取 `origin` 并创建隔离分支 worktree |
| Implementation | `implemented` | 通过已配置的 agent 命令规划、编辑、运行聚焦检查、commit 和 push |
| Test | `tested` | 运行已配置的仓库验证命令 |
| Review | `reviewed` | 通过已配置的 agent 命令审查分支并修复有效发现 |
| Pull request | `pull-request-open` | 复用该分支已打开的 pull request 或创建一个，然后持久化其规范 URL |

任何阶段失败都会记录 `failed`、失败阶段、失败文本和命令尝试。`factory_resume` 在现有 worktree 中重新运行该失败阶段，并继续后续未完成阶段。它绝不重复已完成阶段。在写入失败记录前宿主停止时，需要操作者检查，而不是推断式重试。

## 持久历史与并发

每个已配置仓库使用一个仅所有者可读的 `{ formatVersion: 0, runs }` JSON 文件。运行存储其品牌化 id、issue、分支、worktree、状态转换、命令尝试、失败阶段和 pull request URL。写入在文件锁下通过原子替换完成。Loader 会拒绝格式错误、未来版本、实验性数组以及 worktree 路径不一致的数据，而不是迁移它们。

历史锁还会阻止同一 issue 的第二个活跃运行。不同 issue 可以并发执行，因为每个运行都有自己的分支和 worktree。失败和成功的 worktree 都可供检查，直到开发者通过 Git 将其删除。

## 认证与所有权

已配置命令是可执行文件与参数向量，绝不是 shell 文本。子环境会移除名称形似凭据的变量和继承的 `DSH_*` 值。嵌套 agent 通过 Harness 凭据存储认证，GitHub 操作通过 `gh` 凭据存储认证。

仓库策略仍是 required check、批准、merge、部署和 release 的权威。Factory 记录本地编排事实；它不创建组织身份、治理、合规或 release 系统。
