---
description: "为 dsh 主代理选择 OAuth 支持的 Codex 目录路由的配置档 bundle。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-codex

[English](README.md) | 中文

## 概述

添加此 bundle，使配置档的主代理使用 OAuth 支持的 `openai-codex` 路由。此 bundle 默认选择 `gpt-5.6-luna`，且不配置 API 密钥。`web-codex` 与 `headless-codex` 将它与标准 Web 和 headless 层一起包含。发送请求前，请在 Web Models 授权界面中登录。已有的 `dsh-subagent-codex` 包仍是独立的子进程集成。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 启动内置配置档

运行 Web 配置档，并在 Models 页面完成 `openai-codex` OAuth 流程：

```text
dsh --profile web-codex --no-open
```

同一 Harness home 获得 OAuth 授权后，运行 `dsh --profile headless-codex "<task>"`。配置档的凭据存储拥有该授权；Codex CLI 登录不会复制到其中。

### 将此层加入其他配置档

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-codex
```

此 bundle 替换配置档的 `llm-pi-ai` 路由配置和主代理默认模型。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

[`cordis.patch.yml`](cordis.patch.yml) 配置已安装 pi-ai 的 `openai-codex` 目录路由和默认模型行。[`src/index.ts`](src/index.ts) 不携带运行时行为。`dsh-app-boot` 中的配置档模板在 base 和应用 bundle 后组合此层。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-llm-pi-ai](../../llm/llm-pi-ai/README.zh.md) — 提供方路由和 OAuth 授权。
- [dsh app boot](../../boot/app-boot/README.zh.md) — 配置档初始化和层。

<a id="model-experience"></a>
## 模型体验

此间接 bundle 通过 `dsh-llm-pi-ai` 选择提供方和模型，后者拥有请求转换、OAuth 刷新和模型可见行为。

#### KV Cache effect

此 bundle 不直接改变提示前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **Harness 所有的 OAuth** — 从 Models 页面授权每个隔离的 `DSH_HOME`；此 bundle 不配置或导入 API 密钥。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
