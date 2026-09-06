---
description: "Durable project-serialized command-center task records, approvals, recovery, and cancellation state."
kind: "package-reference"
---
# Task Control

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-task-control` records an explicit project allowlist and command-center tasks outside executor processes, rejects overlapping approved directories, serializes tasks for overlapping paths, binds approvals to executor launches and exact staged changes, and reports unfinished execution or apply work honestly after restart.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package with a storage provider before a task executor or command surface. `registerProject()` records a canonical folder as explicitly approved and rejects parent/child overlap with another approval; shared workspaces outside this allowlist cannot receive command-center tasks. `TaskControl` owns task creation, approval consumption, lifecycle transitions, restart recovery, and durable Discord terminal-delivery markers.

`recordCopy()` binds an approved running task to one private snapshot root, canonical original directory, and exact manifest SHA-256. `recordChanges()` then binds the complete post-run change-set digest. `beginApply()` consumes a dashboard decision only when it names that digest, and `finishApply()` records the outcome. Restart changes an in-progress apply to `apply-interrupted` for manual inspection; it never retries the filesystem operation. `recordExecutionError()` persists cleanup failure details without changing a running or cancelling task to a terminal state.

<a id="model-experience"></a>
## Model Experience

None, as durable task records do not enter a model request.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Task records retain bounded redacted diagnostics, not full executor transcripts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published; the domain schema and one task service own all durable transitions, so no independent same-process authority exists to compare.

</details>
