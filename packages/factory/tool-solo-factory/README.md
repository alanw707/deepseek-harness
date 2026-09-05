---
description: "Let a Harness agent start or resume a configured solo-developer issue-to-pull-request run."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-solo-factory

English | [中文](README.zh.md)

## Summary

`dsh-tool-solo-factory` gives a Harness agent explicit operations to start one issue or resume one failed run. The start operation accepts issue identity and requirements; both operations wait for the local factory and return its run id, terminal state, and pull-request URL or retained worktree. The package does not merge, release, schedule, or remove worktrees.

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

Mount the package through [`headless-solo-factory`](../../bundle/solo-factory/README.md) for the supported application path. Direct custom compositions must provide all paths and command vectors.

### When to choose it

Choose this package when an existing Harness agent should start the foreground factory pipeline through model-facing tools. Use [`dsh-solo-factory`](../solo-factory/README.md) directly for trusted programmatic callers that do not need model-visible tools.

### Minimal configuration

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

| Field | Default | Meaning |
|---|---|---|
| `repository` | required | Git checkout whose `origin/HEAD` starts each run |
| `worktreeRoot` | required | Private directory for retained worktrees |
| `historyFile` | required | Owner-only versioned JSON history |
| `branchPrefix` | required | Namespace for generated branches |
| `implement` | required | Planning, implementation, focused-check, commit, and push command |
| `test` | required | Repository verification command |
| `review` | required | Branch review command |
| `pullRequest` | required | GitHub pull-request creation command |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-solo-factory) is the exhaustive source for accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin constructs one `SoloFactory` and registers `factory_run` plus `factory_resume`. The library owns execution and persistence; this Consumer owns only model-facing schemas and concise result text.

| Source | Purpose |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation and tool registration |
| [`tests/loader-composition.spec.ts`](tests/loader-composition.spec.ts) | Real Loader composition and model-visible schema coverage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-solo-factory`](../solo-factory/README.md) — run lifecycle and local history.
- [`solo-factory` bundle](../../bundle/solo-factory/README.md) — shipped profile defaults.
- [Tool subsystem](../../../docs/subsystems/tools.md) — registration and execution behavior.

-----

<a id="model-experience"></a>
## Model Experience

### Factory tools

#### What the model sees

The model receives the generated [`factory_run` and `factory_resume` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-solo-factory). Results identify the durable run and report its state with the pull-request URL on success or retained worktree before success. A recorded stage failure returns `failed`, its stage, run id, and worktree as a normal tool result so the model can invoke `factory_resume`; configuration and validation errors without a durable failed run still reject.

#### Token effect

The two stable tool schemas add a fixed request cost.

#### KV Cache effect

Stable while the plugin configuration and tool definitions are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Foreground execution** — each tool call remains open until its run succeeds or a command records failure.
- **Trusted configuration** — tool arguments cannot replace command vectors or storage paths.
- **No history listing tool** — callers retain a failed run id for `factory_resume` or inspect the owner-only history file outside the model.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
