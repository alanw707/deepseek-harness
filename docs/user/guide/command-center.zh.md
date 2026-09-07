# 运行本地命令中心

[English](command-center.md) | 中文

Software Factory 注册明确选择的 WSL 项目文件夹，并为一个本地用户启动新的独立 Pi、Codex 或 OpenClaw 运行。随附的 `web` 和 `web-codex` profile 默认包含它。Host API 只绑定到 `127.0.0.1`；Discord 使用出站 bot 连接，不公开入站公共服务器。Software Factory 在现有 DSH Web shell 中渲染：`/` 仍打开带有 session、workspace、model 和 permission 控制、tool、plan、workflow 及 settings 的 DSH Chat；使用 sidebar 中的 Software Factory link 或 `Ctrl+Shift+T` 进入执行器 workspace。

## 检查执行器

以运行命令中心的同一 WSL 用户安装并认证每个执行器。确认 `pi --version`、`codex --version` 和 `openclaw --version`，然后在启用 Discord 前通过每个执行器运行一个良性 headless 命令。Pi 必须具有可用的 `openai-codex` OAuth（`pi auth check --provider openai-codex --no-refresh`），而且 Codex 必须具有有效 auth 文件（`codex login status`）。命令中心对该 Codex 凭据源进行没有刷新权限的 staging，将其复制到 sandbox 临时区域下的可写逐次运行 `CODEX_HOME`，且从不写入源文件；过期的 access token 会使任务失败，而不会轮换现有应用会话使用的凭据。OpenClaw 保留其隔离的受支持认证。执行器不会附着到现有应用会话。

将认证保留在已注册项目之外的执行器用户配置中。切勿把 OAuth 材料、API key、Discord bot token 或 OpenClaw 凭据放入此仓库、已注册项目、任务指令或任务输出。

将 `DSH_COMMAND_CENTER_OPENCLAW_CONFIG` 设为所有已注册项目之外的隔离 OpenClaw 任务配置，或创建默认路径 `$DSH_HOME/command-center/openclaw-task.json`。其父目录应为 mode `0700`，文件应为 mode `0600`；请省略逐 agent `agents.entries` 和旧版 `agents.list`，因为除非一个不可覆盖的默认配置强制执行 Docker 隔离、将 Docker `user` 设为命令中心 host 用户的数字 `uid:gid`、仅对所选工作区的读写访问、无容器网络、只读根文件系统、丢弃 capabilities、无 elevation 以及仅 sandbox 文件系统/runtime 工具，否则命令中心会拒绝该配置。

可选的 `DSH_COMMAND_CENTER_PI_COMMAND`、`DSH_COMMAND_CENTER_PI_MODEL`、`DSH_COMMAND_CENTER_CODEX_COMMAND`、`DSH_COMMAND_CENTER_CODEX_AUTH`、`DSH_COMMAND_CENTER_OPENCLAW_COMMAND` 和 `DSH_COMMAND_CENTER_DOCKER_COMMAND` 值选择已安装的可执行文件路径、Pi 模型和 Codex auth 源。Codex auth 源默认为 `$CODEX_HOME/auth.json` 或 `~/.codex/auth.json`。Pi 通过 `auth check --no-refresh --credentials --json` 读取缓存的 bearer token，并通过临时 provider override 接收它。Pi 和 Codex 仅在 sandbox 临时区域下写入所需的逐次运行状态；Codex 接收不含 refresh token 的 auth 副本，因此命令中心运行无法轮换永久 auth store。凭据值会保留用于精确输出脱敏，私有 staging 和临时运行时状态会在结束后删除，并且 Pi 文件工具会阻止副本项目之外的所有路径。

将 `DSH_COMMAND_CENTER_COPIES` 设为所有已注册项目之外、已存在且仅所有者可访问的目录；默认值为 `~/.dsh-command-center/task-copies`。副本准备拒绝符号链接和特殊文件，排除凭据及配置名称和 `node_modules`，并保留私有基线。profile 将准备过程限制为 100,000 个条目和 1 GiB，并将完整前后更改审查限制为 1 MiB；需要时在 profile 补丁中调整 `copies` 或 `reviewLimitBytes`。如果 Codex 安装位置不在最小系统路径内，将 `DSH_COMMAND_CENTER_CODEX_READ_ROOTS` 设为该安装所需静态运行时目录的绝对路径 JSON 数组。不要授予凭据目录访问权限。

## 配置专用 Discord bot

创建专用 Discord application 和 bot；不要复用 OpenClaw bot。启用 Message Content privileged intent，只邀请 bot 进入预期服务器，并且在预期频道中只授予 View Channels、Send Messages 和 Read Message History。配置的控制用户发来的 direct message 不需要服务器或频道 allowlist。启用 Discord Developer Mode，并复制控制用户 ID 以及每个允许的服务器和频道 ID。

通过启动环境在源代码控制之外提供 token 和以逗号分隔的精确 allowlist：

```sh
read -rsp 'Discord bot token: ' DSH_COMMAND_CENTER_DISCORD_TOKEN; echo
export DSH_COMMAND_CENTER_DISCORD_TOKEN
export DSH_COMMAND_CENTER_DISCORD_USER_ID='123456789012345678'
export DSH_COMMAND_CENTER_DISCORD_GUILD_IDS='234567890123456789'
export DSH_COMMAND_CENTER_DISCORD_CHANNEL_IDS='345678901234567890'
# Optional; defaults to !cc
export DSH_COMMAND_CENTER_DISCORD_PREFIX='!cc'
```

对于重复启动，将这些值放入仓库外 mode-`0600` 的环境文件，并通过本地进程管理器加载。省略 guild 和 channel 值即可使用 direct-message-only mode。只有所有 Discord 字段都缺少时才会禁用 Discord；不完整配置或格式错误的 Snowflake ID 会使 profile 加载失败，而不会削弱授权。

## 在本地启动

随附的 Web profile 已经包含命令中心。从仓库启动回环 profile：

```sh
install -d -m 0700 "${DSH_COMMAND_CENTER_COPIES:-$HOME/.dsh-command-center/task-copies}"
pnpm dsh --profile web --no-open --port 3181
```

在 WSL 浏览器环境中打开 `dsh web` 打印的完整 URL。该认证 URL 会打开 DSH shell；在 sidebar 中选择 Software Factory 或按 `Ctrl+Shift+T` 进入执行器工作，也可在认证后打开 `/command-center`。不要转发此端口、将 Web profile 绑定到其他接口或通过反向代理发布它。route 使用 shell 的 Web authentication，然后创建 HttpOnly SameSite dashboard session；变更 endpoint 需要该 session 和 CSRF token。

## 使用仪表板

只注册此 WSL 用户希望代理编辑的文件夹。注册是持久的命令中心批准；共享 DSH workspace 不会自动成为项目，并且父子项目路径重叠会被拒绝。在 Software Factory 中选择项目和执行器，写入一条有界指令，然后选择 **Continue to review**。检查指定项目和请求后只选择一次 **Approve & start**；该操作会消费启动批准并分派私有运行。待批准、queued 和 running 任务都提供取消，route 刷新任务状态时不会关闭输出或更改详情。

取消会请求终止整个进程树，并且只在受管进程树退出后报告 `cancelled`。相同或重叠项目路径的工作会串行执行，无关的已注册项目可以独立运行。

## 使用 Discord

专用 bot 会接受配置用户在 direct message 中发出的命令，或接受用户、服务器和频道匹配配置 guild allowlist 的命令：

```text
!cc help
!cc projects
!cc run <project-id> <pi|codex|openclaw> <task instruction>
!cc status [task-id]
!cc cancel <task-id>
```

`run` 会持久创建任务并确认其 ID，但会将其留在 `pending-approval`；Discord 无法批准或分派任务。使用仪表板检查准确指令并选择 **Approve & start**。bot 在发起请求的 guild channel 或 direct message 中报告终止成功、失败、取消或中断，并跨重启持久化成功通知交付。

## 应用批准策略

执行器收到的工作目录是私有项目副本，而非原项目。Pi 没有 shell，其文件工具仅限于该副本；Codex 使用命名权限，拒绝访问原项目和私有快照文件，同时允许编辑工作区并禁止子命令联网；OpenClaw 将该副本作为容器工作区。没有完整强制限制的执行器会被拒绝。

启动批准授权在隔离副本中执行，而非将更改应用到原项目。成功运行后，选择 **Review exact changes**，并检查每个完整 UTF-8 前后值或目录 mode。**Apply these exact changes** 会记录并消耗绑定到所显示 SHA-256 digest 的第二次持久批准。应用尝试会全局串行化，并且在受影响的原路径已变化、消失、新出现、改变类型或权限，或者具有多个硬链接时拒绝。push、网络部署、访问 `.git`、受保护凭据路径、二进制更改以及文件/目录类型替换保持被阻止，不会绕过审查。

## 重启后恢复

项目批准和任务历史会在命令中心重启后保留。持久化为 `running` 或 `cancelling` 的任务变为 `interrupted`，并且从不静默重启；Discord 来源的中断任务在 bot 重新连接后收到终止通知。应用操作丢失命令中心进程时会变为 `apply-interrupted`，并且绝不重试；继续前请手动检查原项目和保留的更改集。检查任何失败或中断详情，确认没有受管进程残留，然后在适合重试时创建并批准新任务。
