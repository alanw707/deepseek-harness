---
version: 1
slug: "packages-host-task-dashboard-src-index-ts"
primary_target: "packages/host/task-dashboard/src/index.ts"
related_targets: []
---

# Command Center dashboard

## Scope and mode
Operate. The authenticated loopback Tasks route is a companion to the original Chat route.

## Audience and job
A local developer registers a project, gives one bounded instruction to Pi, Codex, or OpenClaw, reviews the private result, and decides whether to apply it.

## Direction contract
THESIS: Make the human approval boundary the visual spine; refuse an executor-first chat shell.
OWN-WORLD: Restrained light utility canvas, cool neutral surfaces, one indigo action accent, green success, amber review, red failure, compact system UI, and code-like review panes.
STORY: The visitor sees the four-step path, creates a task, approves its start, watches the private run, inspects exact before-and-after content, and applies only the matching digest.
FIRST VIEWPORT: A two-column hero places the promise and four-step path on the left and the task form beside setup/history; attention tasks continue below with the next action visible.
FORM: Guided command-center workspace, selected for explicit state and review clarity; no concept seed was run because the user specified the additive companion workflow and existing DSH UI context.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## States and interaction
New, pending approval, queued, running, cancelling, succeeded with pending review, applying, applied, and failure states remain visible. Polling preserves open details and scroll positions. Small screens stack all columns and turn primary actions full-width.

## Constraints and open decisions
Preserve the original authenticated Chat surface, DSH controls, session data, model/provider behavior, and loopback authentication. Keep task executors in private snapshots and require exact digest approval for apply. Product copy remains locale-owned when rendered through the broader client UI; this standalone route currently serves English copy.
