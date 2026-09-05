---
description: "The local solo-factory package group: durable issue-to-pull-request execution and the model-facing tools that start or resume it."
kind: "package-group"
---

# factory/ — local issue-to-pull-request runs

English | [中文](README.zh.md)

## Summary

The factory group lets one developer hand a GitHub issue to a local Harness agent and receive an isolated retained worktree or an open pull request. The library owns Git worktrees, stage execution, history, resume, duplicate-run rejection, and GitHub pull-request reuse. The Consumer contributes the explicit start and resume tools. No package in this group merges, releases, schedules, or removes worktrees.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`solo-factory`](solo-factory/README.md) | Shell-free implementation, test, review, and pull-request pipeline with durable local history |
| [`tool-solo-factory`](tool-solo-factory/README.md) | Model-facing `factory_run` and `factory_resume` Consumer |

The installable [`solo-factory` bundle](../bundle/solo-factory/README.md) composes both packages into the shipped `headless-solo-factory` profile.

<a id="related-documentation"></a>
## Related documentation

- [Solo factory subsystem](../../docs/subsystems/solo-factory.md) — lifecycle, persistence, concurrency, and ownership.
- [Solo factory Agent Note](../../.agents/notes/implemented/feature/2026-09-03-solo-factory-run.md) — lifecycle, persistence, and human-gate decisions.
- [Application boot](../boot/app-boot/README.md) — profile composition and launch rules.
- [Bundle catalog](../bundle/README.md) — installable profile layers.

<a id="dev-note"></a>
## Dev Note

None.
