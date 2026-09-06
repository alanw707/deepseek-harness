---
description: "Runs approved command-center tasks in project workspaces with executor-specific confinement and owned-process cancellation."
kind: "package-reference"
---
# Task Execution

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-task-execution` launches one independent Pi, Codex, or OpenClaw task in a private project copy after dashboard approval, retains bounded safe diagnostics, derives exact reviewable changes, applies only a dashboard-approved digest when the original still matches its baseline, and owns cancellation without attaching to existing executor sessions.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount task control and a sandbox provider before this package; configure executor and Docker CLI paths, an existing private `copies.directory` with entry/byte limits, `reviewLimitBytes`, and the isolated OpenClaw configuration through the owning profile. A task remains pending until the dashboard records approval, and every run consumes that approval once. Pi reads a cached OpenAI Codex bearer through `pi auth check --no-refresh --credentials --json` and receives it through an ephemeral provider override; unavailable or expired authentication fails the task without refreshing permanent credentials. Codex stages its configured auth source without the refresh token and copies it into a writable per-run `CODEX_HOME` under the sandbox temporary area, so a run cannot rotate permanent Codex credentials; staged credential values are redacted from captured output. Pi uses the same temporary-area pattern for its required runtime state, while its file tools reject every path outside the copied workspace.

Terminal settlement waits for process-tree exit and runtime cleanup, then records a digest over complete UTF-8 before/after contents and directory modes within `reviewLimitBytes`. A zero-entry result is recorded as `no-change` and needs no review or apply. `review()` verifies that retained files still match that digest. `apply()` durably consumes approval for a non-empty displayed digest, serializes all apply attempts, rejects changed originals, and rolls back completed entries when a later operation fails. Service disposal waits for apply quiescence. Cleanup failures retain a nonterminal task and durable error detail; explicit cancellation retries cleanup.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the selected external executor, which owns its model request and credentials.

#### KV Cache effect

No direct DSH model-request effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Copy preparation and reviewed apply require Linux; the executor set is Pi, Codex, and OpenClaw.
- Reviewed apply accepts bounded UTF-8 regular files and directories. It rejects binary changes, file/directory type replacement, changed originals, and replacement of multiply hard-linked files.
- A process loss during apply is reported as `apply-interrupted` and requires manual project inspection; it is never retried automatically.
- OpenClaw task execution requires a separately managed isolated configuration file with no per-agent `entries` or legacy `list`; its Docker user must match the host user as `uid:gid`, its sandbox tool allowlist must contain exactly `group:fs` and `group:runtime`, and additional bind mounts are rejected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`prepareTaskCopy()` prepares Linux-only private workspace and baseline directories using descriptor-relative reads. It rejects symlinks and special files, separates hard-linked source inodes, bounds visited entries and bytes, records excluded credential/configuration names, and removes partial copies on failure or cancellation. `TaskExecution.run()` binds its manifest fingerprint to the durable task before launching in the copied workspace. The outer sandbox grants writes to that workspace and its backend temporary area; the original, immutable baseline, manifests, and credential inputs remain read-only. Pi and Codex create writable per-run homes under the temporary area through a read-only launcher and remove all host staging after settlement. Codex uses named filesystem permissions and optional `runtimeReadRoots`, with original/snapshot/runtime reads and child networking denied. OpenClaw's protected launcher removes the Docker container selected by the exact workspace mount, then removes generated `.openclaw` state before exact change derivation.

No runtime invariant companion is published; one execution service owns each process handle through durable settlement, and lifecycle tests cover process/task synchronization.

</details>
