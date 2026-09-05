# Solo factory

English | [中文](solo-factory.zh.md)

The solo factory turns one manually supplied GitHub issue into an isolated local run that ends with an open pull request. [`@deepseek-ai/dsh-solo-factory`](../../packages/factory/solo-factory/README.md) owns execution and persistence, [`@deepseek-ai/dsh-tool-solo-factory`](../../packages/factory/tool-solo-factory/README.md) owns model-facing start and resume operations, and the [bundle](../../packages/bundle/solo-factory/README.md) supplies the shipped `headless-solo-factory` composition. The pull request is the only human gate; merge, release, scheduling, intake, and cleanup stay outside this subsystem.

## Run lifecycle

A new run receives an issue id, title, and body. It creates a unique branch from `origin/HEAD` and a retained worktree, then executes these stages in order:

| Stage | Successful durable state | Operation |
|---|---|---|
| Workspace | `workspace-ready` | Fetch `origin` and create the isolated branch worktree |
| Implementation | `implemented` | Plan, edit, run focused checks, commit, and push through the configured agent command |
| Test | `tested` | Run the configured repository verification command |
| Review | `reviewed` | Review the branch and fix valid findings through the configured agent command |
| Pull request | `pull-request-open` | Reuse an open pull request for the branch or create one, then persist its canonical URL |

Any stage failure records `failed`, the failed stage, failure text, and the command attempt. `factory_resume` reruns that failed stage in the existing worktree and continues through later incomplete stages. It never repeats a completed stage. A host stop before a failure record remains an operator-inspection case rather than an inferred retry.

## Durable history and concurrency

Each configured repository uses one owner-only `{ formatVersion: 0, runs }` JSON file. A run stores its branded id, issue, branch, worktree, state transitions, command attempts, failed stage, and pull-request URL. Writes use atomic replacement under a file lock. The loader rejects malformed, future-version, experimental array, and worktree-path-inconsistent data instead of migrating it.

The history lock also prevents a second active run for the same issue. Separate issues can execute concurrently because each run has its own branch and worktree. Failed and successful worktrees remain available for inspection until the developer removes them through Git.

## Authentication and ownership

Configured commands are executable-and-argument vectors, never shell text. Child environments remove credential-shaped variables and inherited `DSH_*` values. Nested agents authenticate through the Harness credential store and GitHub operations authenticate through the `gh` credential store.

Repository policy remains authoritative for required checks, approval, merge, deployment, and release. The factory records local orchestration facts; it does not create an organizational identity, governance, compliance, or release system.
