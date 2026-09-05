# Agent Note: Solo factory run

Status: implemented

English | [中文](2026-09-03-solo-factory-run.zh.md)

## Problem
A solo developer needs one durable path from a GitHub issue to isolated implementation and an open pull request without manually coordinating worktrees, repeated agent invocations, verification, review, and failure recovery. The path must not turn the pull request into an automatic approval, merge, or release mechanism.

## Decision
`@deepseek-ai/dsh-solo-factory` owns one local issue-to-pull-request run. A configured run creates a branch from `origin/HEAD`, creates and retains an isolated Git worktree, then executes shell-free command vectors for implementation, focused testing, review, and pull-request creation. The implementation and review vectors may run separate `headless-codex` agents; their invoked profiles own their Session logs.

The durable state vocabulary is `accepted`, `workspace-ready`, `implemented`, `tested`, `reviewed`, `pull-request-open`, and `failed`. A successful run ends at `pull-request-open` and stores the canonical GitHub URL. No factory package exposes merge or release behavior.

The history file is an owner-only, atomically replaced `{ formatVersion: 0, runs }` document. Every transition stores its timestamp; every command attempt stores the shell-free command, start and finish timestamps, success or failure, bounded captured output when requested, and failure text. The loader validates every record and verifies that each stored worktree is the configured branch's expected child of the configured worktree root. Experimental array history and any future version fail with `unsupported solo factory history format`; this pre-release format has no migration path.

A file lock serializes history mutations and duplicate detection. Runs for separate issues may proceed in separate worktrees, while a second active run for the same repository and issue is rejected. `resume(runId)` accepts only a failed run, reruns its recorded failed stage, and continues with subsequent incomplete stages without repeating completed commands. Pull-request recovery first asks `gh pr list` for an open pull request on the branch, so resuming a failed PR stage reuses an existing pull request instead of creating a duplicate.

`@deepseek-ai/dsh-tool-solo-factory` contributes fixed `factory_run` and `factory_resume` Consumers. A persisted stage failure returns a model-visible `failed` result with its stage, run id, and worktree, so the same caller can invoke `factory_resume` without reading the private history file. The installable solo-factory bundle supplies local `dsh`, `pnpm`, and `gh` command defaults. The shipped `headless-solo-factory` profile composes base, headless, Codex, and solo-factory layers and starts only through `dsh --profile`.

Child commands receive a scrubbed environment that removes credential-shaped variables and `DSH_*` variables. Harness OAuth and `gh` credential stores therefore remain the supported authentication paths instead of ambient secret forwarding.

## Alternatives considered

**An enterprise orchestration plane.** Tenant identity, governance policy, approval services, dashboards, webhooks, queues, release automation, and compliance records add unrelated operators and failure modes for a one-developer workflow. Those capabilities are absent; repository review policy remains the authority.

**Automatic merge and release after review.** Automated review is advisory and cannot replace the human pull-request gate. Ending at an open pull request keeps approval, merge, deployment, and release policy in GitHub and the repository's existing processes.

**A workflow script alone.** `dsh-workflow` can coordinate subagents but does not own Git worktree isolation, durable cross-process run history, duplicate issue detection, or GitHub pull-request recovery.

**A GitHub webhook flow.** Automatic intake introduces webhook credentials, retries, background execution, and queue semantics. Manual invocation is sufficient for one developer and makes the start decision explicit.

**Manual worktrees and `gh`.** Existing commands remain useful escape hatches, but alone they do not provide a validated run record, failed-stage resume, or duplicate pull-request prevention.

## Consequences

The developer gets one manual command surface, retained isolation, inspectable owner-only state, resumable recorded command failures, and a pull-request URL as the handoff. Focused tests use real temporary Git repositories, fake command adapters, and a real Loader composition to pin worktree, history, resume, duplicate-run, tool-schema, bundle, and profile behavior.

Runs remain foreground operations. An abrupt host stop can leave a non-failed active record that requires manual inspection rather than inferred resume. Worktrees are never removed automatically. GitHub access requires an authenticated `gh` credential store, nested agents require Harness-owned OAuth, and the repository still owns branch protection, required checks, review approval, merge, deployment, and release.
