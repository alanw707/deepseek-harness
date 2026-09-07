---
description: "Adds the local Software Factory task lifecycle, executor configuration, and browser route to a DSH Web profile."
kind: "package-bundle"
---
# Software Factory Bundle

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-command-center-bundle` adds an explicit project allowlist, durable task control, isolated executor launches, exact staged-change review and apply approval, a loopback Software Factory route, and optional allowlisted Discord control to an existing DSH Web composition; the original Chat and its major Harness features remain available, while credentials and executable paths stay outside source control.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Create the owner-only copy-storage directory described in the setup guide. The shipped `web` and `web-codex` profiles include this bundle, so `dsh --profile web` adds Software Factory beside the original Chat without replacing the Web profile's client features; custom profiles can apply [cordis.patch.yml](cordis.patch.yml) directly. Configure `DSH_COMMAND_CENTER_OPENCLAW_CONFIG` with the path to the isolated OpenClaw task configuration, or create the default `$DSH_HOME/command-center/openclaw-task.json`. The patch uses `pi`, `codex`, `openclaw`, and `docker` unless matching command variables select other executable paths; `DSH_COMMAND_CENTER_CODEX_AUTH` may select a Codex auth source outside its default home. `DSH_COMMAND_CENTER_COPIES` selects retained-copy storage, and `DSH_COMMAND_CENTER_CODEX_READ_ROOTS` selects static Codex runtime directories as a JSON array. Set `DSH_COMMAND_CENTER_DISCORD_TOKEN` and `DSH_COMMAND_CENTER_DISCORD_USER_ID` to enable the dedicated Discord bot; set both guild and channel variables for guild commands, or omit both for direct-message-only ingress. Omit all Discord variables to keep Discord disabled. Follow the [command-center setup guide](../../../docs/user/guide/command-center.md) for local binding, credentials, allowlists, approval policy, and restart recovery.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch supplies deployment values while the inserted packages own storage, process confinement, and HTTP behavior.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the inserted task-execution package, which starts external agents that own their model requests.

#### KV Cache effect

No direct DSH model-request effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The bundle requires a loopback web profile and a separately managed OpenClaw task configuration.
- Discord control requires a dedicated bot with Message Content intent and an exact controlling user; guild commands additionally require exact server and channel allowlists.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published; the bundle contributes composition only, while the inserted packages own and verify runtime state.

</details>
