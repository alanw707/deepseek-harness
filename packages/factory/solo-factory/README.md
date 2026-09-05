---
description: "Run one GitHub issue through an isolated local worktree, agent implementation, verification, review, and pull-request creation with resumable JSON history."
kind: "package-library"
---

# @deepseek-ai/dsh-solo-factory

English | [中文](README.zh.md)

## Summary

`dsh-solo-factory` runs one issue from a configured Git checkout to an open GitHub pull request. It retains the generated branch and worktree, records each completed stage in an owner-only JSON file, and resumes a command failure without repeating completed stages. The library stops at the pull request; repository policy owns merge and release.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use this library from a Cordis Consumer or another trusted local caller that already has issue id, title, and requirements. Use the [`tool-solo-factory`](../tool-solo-factory/README.md) Consumer instead when a Harness agent starts or resumes runs.

### Entry point

```text
const factory = new SoloFactory(config)
const run = await factory.execute({ id, title, body })
const resumed = await factory.resume(runId)
```

`execute()` creates a branch from `origin/HEAD`, creates a retained worktree, and runs the configured implementation, test, review, and pull-request commands without a shell. Success returns `pull-request-open` with `pullRequestUrl`. A recorded failure rejects with `FactoryRunError`; its `run` carries the id, `failedStage`, and worktree needed for `resume()` or inspection.

The history file uses format version `0`. A file from the experimental array format, a malformed record, or a record whose worktree does not belong to the configured worktree root fails with `unsupported solo factory history format`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`SoloFactory` serializes history updates with the shared atomic-write lock, while separate issue runs execute concurrently in separate worktrees. `LocalCommandRunner` inherits ordinary process settings but removes credential-shaped and `DSH_*` environment variables; configured commands receive arguments directly. Before pull-request creation, the library queries `gh` for an open pull request on the branch and reuses it when present.

| Source | Purpose |
|---|---|
| [`src/index.ts`](src/index.ts) | Run lifecycle, history validation, worktree creation, command execution, and GitHub PR lookup |
| [`tests/solo-factory.spec.ts`](tests/solo-factory.spec.ts) | Real temporary-Git behavior and command-adapter coverage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`tool-solo-factory`](../tool-solo-factory/README.md) — model-facing start and resume operations.
- [`solo-factory` bundle](../../bundle/solo-factory/README.md) — shipped `headless-solo-factory` composition.
- [Solo factory Agent Note](../../../.agents/notes/implemented/feature/2026-09-03-solo-factory-run.md) — lifecycle and scope rationale.

-----

<a id="model-experience"></a>
## Model Experience

None, as the library registers no prompt, tool, or model context; configured implementation and review profiles own any model use.

#### KV Cache effect

Nothing here enters the caller's request prefix, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Recorded failures only** — `resume()` handles a command that rejected and produced a `failed` record; it does not infer an interrupted process after an abrupt host stop.
- **GitHub pull requests only** — PR recovery calls the authenticated `gh` CLI and reuses an open pull request for the generated branch.
- **Manual cleanup** — successful and failed worktrees remain until the user removes them with Git.
- **No merge or release** — the pull request is the human gate and terminal factory outcome.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
