---
description: "向 DSH Web profile 添加本地 Software Factory 任务生命周期、执行器配置和浏览器路由。"
kind: "package-bundle"
---
# Software Factory Bundle

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-command-center-bundle` 向现有 DSH Web composition 添加明确的项目 allowlist、持久任务控制、隔离的执行器启动、精确 staging 更改审查与应用批准、回环 Software Factory route 和可选的 allowlist Discord 控制；原有 Chat 及其主要 Harness 功能继续可用，凭据和可执行文件路径保留在源代码控制之外。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

创建设置指南中所述的仅所有者可访问的副本存储目录。随附的 `web` 和 `web-codex` profile 包含此 bundle，因此 `dsh --profile web` 会在原有 Chat 旁增加 Software Factory，而不替换 Web profile 的 client 功能；自定义 profile 可以直接应用 [cordis.patch.yml](cordis.patch.yml)。将 `DSH_COMMAND_CENTER_OPENCLAW_CONFIG` 配置为隔离 OpenClaw 任务配置的路径，或创建默认路径 `$DSH_HOME/command-center/openclaw-task.json`。该补丁使用 `pi`、`codex`、`openclaw` 和 `docker`，除非匹配的命令变量选择其他可执行文件路径；`DSH_COMMAND_CENTER_CODEX_AUTH` 可以选择默认 home 之外的 Codex auth 源。`DSH_COMMAND_CENTER_COPIES` 选择保留副本的存储位置，`DSH_COMMAND_CENTER_CODEX_READ_ROOTS` 以 JSON 数组选择静态 Codex 运行时目录。设置 `DSH_COMMAND_CENTER_DISCORD_TOKEN` 和 `DSH_COMMAND_CENTER_DISCORD_USER_ID` 以启用专用 Discord bot；设置 guild 和 channel 变量以启用 guild 命令，或省略两者以启用 direct-message-only ingress。省略所有 Discord 变量则保持 Discord 禁用。请按照[命令中心设置指南](../../../docs/user/guide/command-center.zh.md)配置本地绑定、凭据、allowlist、批准策略和重启恢复。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

该补丁提供部署值，插入的包拥有存储、进程限制和 HTTP 行为。

</details>

-----

<a id="model-experience"></a>
## 模型体验

间接。插入的任务执行包启动外部代理，后者拥有其模型请求。

#### KV Cache 影响

没有直接 DSH 模型请求影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 此 bundle 需要回环 Web profile 和单独管理的 OpenClaw 任务配置。
- Discord 控制需要具有 Message Content intent 和精确控制用户的专用 bot；guild 命令还需要精确的服务器和频道 allowlist。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布运行时不变量 companion；该 bundle 只贡献组合，插入的包负责并验证运行时状态。

</details>
