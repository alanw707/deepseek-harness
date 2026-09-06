---
description: "为已注册项目和已批准命令中心任务提供仅回环的浏览器仪表板。"
kind: "package-reference"
---
# Task Dashboard

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-host-task-dashboard` 在原有 DSH Chat 旁提供独立的回环 Tasks surface。组合后的 Web profile 保留 session、workspace、model 和 permission 控制、tool、attachment、plan、workflow、subagent、settings 及其他 client 功能；仪表板增加明确的项目注册、引导式任务启动、输出检查、精确 staging 更改审查与应用批准，以及可选的 allowlist Discord 任务控制。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在本包之前挂载 Web 服务器、任务控制和任务执行；通过 `dsh web` 打印的完整 URL 完成认证，然后用 Chat 进行原有 DSH 对话，或用 Tasks 处理执行器工作。仪表板拒绝非回环请求、未经认证的 API 调用、过期会话、超大 JSON 请求体和缺少页面会话 CSRF token 的变更请求。注册会持久批准一个规范化文件夹，并拒绝与另一个已批准文件夹重叠；其他共享 DSH workspace 不会显示为命令中心项目。

每个任务卡都指定其项目。引导路径先创建供审查的任务，再用 **Approve & start** 合并启动批准和分派，并让待批准或 queued 任务保持可取消。任务输出和 staging 更改审查在自动刷新期间保留读者选择的展开、折叠和滚动状态。仅在页面加载完整的前后 UTF-8 内容并提交其精确 digest 后，应用才可用。

缺少全部 Discord 字段时会禁用 Discord。启用它需要专用 bot token、一个控制用户 ID 以及非空的精确服务器和频道 allowlist；Discord 可以创建、检查和取消任务，但无法批准或分派任务。

<a id="model-experience"></a>
## 模型体验

无，因为仪表板浏览器请求不会进入模型请求。

#### KV Cache 影响

无直接影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 仪表板没有远程访问模式。
- 浏览器会话为进程本地并在十二小时后过期。
- Discord 消息命令需要 bot 的 Message Content privileged intent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布运行时不变量 companion；authenticated route 和 Discord 转换统一经过一个仪表板服务，并由行为测试覆盖。

</details>
