---
description: "Provides a loopback-only browser dashboard for registered projects and approved command-center tasks."
kind: "package-reference"
---
# Task Dashboard

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-host-task-dashboard` serves the separate loopback Tasks surface beside the original DSH Chat. The composed Web profile keeps its sessions, workspaces, model and permission controls, tools, attachments, plans, workflows, subagents, settings, and other client features; the dashboard adds explicit project registration, guided task launch, output inspection, exact staged-change review and apply approval, and optional allowlisted Discord task control.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the web server, task control, and task execution before this package; authenticate through the exact URL printed by `dsh web`, then use Chat for original DSH conversations or Tasks for executor work. The dashboard rejects non-loopback requests, unauthenticated API calls, expired sessions, oversized JSON bodies, and mutation requests without the page session CSRF token. Registration durably approves one canonical folder and rejects overlap with another approved folder; other shared DSH workspaces do not appear as command-center projects.

Every task card names its project. The guided path creates a task for review, combines launch approval with dispatch in **Approve & start**, and keeps pending or queued tasks cancellable. Task output and staged-change review preserve the reader's expanded, collapsed, and scroll selection across automatic refreshes. Apply becomes available only after the page loads complete before/after UTF-8 contents and submits their exact digest.

Discord is disabled when all Discord fields are absent. Enabling it requires a dedicated bot token, one controlling user ID, and non-empty exact server and channel allowlists; Discord may create, inspect, and cancel tasks but cannot approve or dispatch them.

<a id="model-experience"></a>
## Model Experience

None, as dashboard browser requests do not enter a model request.

#### KV Cache effect

No direct effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The dashboard has no remote-access mode.
- Browser sessions are process-local and expire after twelve hours.
- Discord message commands require the bot's Message Content privileged intent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published; authenticated route and Discord transitions pass through one dashboard service and have behavior tests.

</details>
