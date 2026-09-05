---
description: "A profile bundle that selects the OAuth-backed Codex catalog route for a dsh main agent."
kind: "package-bundle"
---

# @deepseek-ai/dsh-codex

English | [中文](README.zh.md)

## Summary

Add this bundle to make a profile's main agent use the OAuth-backed `openai-codex` route. The bundle selects `gpt-5.6-luna` by default and does not configure an API key. `web-codex` and `headless-codex` include it with the standard Web and headless layers. Sign in through the Web Models authorization flow before sending a request. The existing `dsh-subagent-codex` package remains a separate subprocess integration.

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

### Start a bundled profile

Run the Web profile and complete the `openai-codex` OAuth flow from the Models page:

```text
dsh --profile web-codex --no-open
```

Use `dsh --profile headless-codex "<task>"` after the same Harness home has an OAuth grant. The profile's credential store owns the grant; a Codex CLI login is not copied into it.

### Add the layer to another profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-codex
```

The bundle replaces the profile's `llm-pi-ai` route configuration and main-agent default model.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[`cordis.patch.yml`](cordis.patch.yml) configures the installed pi-ai `openai-codex` catalog route and the default model row. [`src/index.ts`](src/index.ts) carries no runtime behavior. The profile templates in `dsh-app-boot` compose this layer after the base and application bundles.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm-pi-ai](../../llm/llm-pi-ai/README.md) — provider routes and OAuth authorization.
- [dsh app boot](../../boot/app-boot/README.md) — profile initialization and layers.

## Model Experience

Indirectly, through `dsh-llm-pi-ai`, which owns request conversion, OAuth refresh, and model-visible behavior.

#### KV Cache effect

The bundle changes no prompt prefix itself.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Harness-owned OAuth** — authorize each isolated `DSH_HOME` from the Models page; the bundle neither configures nor imports API keys.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
