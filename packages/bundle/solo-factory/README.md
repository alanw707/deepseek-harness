---
description: "Add model-facing start and resume tools for a local solo-developer issue-to-pull-request workflow to a dsh profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-solo-factory-bundle

English | [中文](README.zh.md)

## Summary

This bundle adds `factory_run` and `factory_resume` to a profile and supplies local command defaults for the solo factory. The shipped `headless-solo-factory` profile combines it with the headless and OAuth-backed Codex layers. Set one repository path, invoke the profile manually, and inspect the retained worktree or open pull request when the foreground run ends. The layer never merges or releases the pull request.

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

### Install into a profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-solo-factory-bundle
dsh plugin --profile <name> remove @deepseek-ai/dsh-solo-factory-bundle
```

In-box bundles resolve from the workspace or installation before npm fallback. Reconciliation activates the declared patch layer; a package without `dsh.bundle.patch` cannot install as a layer.

For the precomposed path, set `DSH_FACTORY_REPOSITORY` to an absolute checkout whose `origin/HEAD` is available, authenticate Harness Codex and the `gh` CLI, then start a task manually:

```text
DSH_FACTORY_REPOSITORY=/absolute/path/to/repository dsh --profile headless-solo-factory "Run factory_run for GitHub issue 123 using its current title and body."
```

The default implementation and review commands run nested `headless-codex` agents. The implementation prompt owns planning, code changes, focused checks, commit, and push. The separate test command runs Vitest with `--changed origin/HEAD`. The PR command uses `gh pr create` and the generated branch.

Override local paths with `DSH_FACTORY_WORKTREE_ROOT`, `DSH_FACTORY_HISTORY_FILE`, and `DSH_FACTORY_BRANCH_PREFIX`. Override each complete command vector with JSON in `DSH_FACTORY_IMPLEMENT`, `DSH_FACTORY_TEST`, `DSH_FACTORY_REVIEW`, or `DSH_FACTORY_PR`.

### What you get

- `factory_run` starts one issue in a new retained branch and worktree.
- `factory_resume` reruns the recorded failed stage, then remaining incomplete stages.
- `dsh-solo-factory` owns local durability, duplicate-run rejection, PR reuse, and the `pull-request-open` terminal state.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) inserts the tool Consumer with paths derived from the Harness home and shell-free executable/argument objects. [`src/index.ts`](src/index.ts) carries no runtime behavior. [`dsh-app-boot`](../../boot/app-boot/README.md) composes this layer after base, headless, and Codex for `headless-solo-factory`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Factory packages](../../factory/README.md) — library and Consumer ownership.
- [dsh app boot](../../boot/app-boot/README.md) — profile initialization and layer order.
- [Bundle catalog](../README.md) — available profile layers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-solo-factory`, which owns the two tool schemas and result text.

#### KV Cache effect

The bundle changes no prompt prefix itself.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Local authenticated clients** — nested agent commands use Harness-owned OAuth; GitHub operations use the `gh` credential store because credential-shaped environment variables are not forwarded.
- **Foreground and manual** — no webhook, scheduler, queue, or background worker starts runs.
- **Retained worktrees** — the user inspects and removes worktrees manually.
- **One repository per mounted layer** — each plugin instance has one repository and one history file.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
