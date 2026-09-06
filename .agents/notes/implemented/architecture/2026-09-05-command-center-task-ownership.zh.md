# Agent Note: Command-center task ownership

Status: implemented

[English](2026-09-05-command-center-task-ownership.md) | 中文

## 问题

独立的 Pi、Codex 和 OpenClaw 运行可以编辑同一本地项目、在其用户配置中保留凭据，并且存活时间超过一个浏览器请求。进程本地仪表板任务无法在重启后诚实恢复，也无法阻止冲突的项目写入。

## 决定

`dsh-task-control` 拥有明确的持久项目 allowlist、任务记录、重叠路径 admission、digest 绑定批准、有界安全诊断和重启恢复。`dsh-task-execution` 拥有已批准的执行器进程、其进程树和一个串行的审查后应用操作。执行会在准备私有项目快照之前消耗启动批准。终止结算要求进程树退出且运行时清理成功。清理失败会保留非终止所有权和持久错误详情；明确请求取消会重试清理。服务释放会停止接收任务、等待应用达到静止状态并报告清理失败。启动时正在运行或取消中的任务变为 `interrupted`，并且不会重新启动；未完成的应用会变为 `apply-interrupted`，且绝不会重试。

命令中心浏览器页面是与组合后的 DSH Web 应用并存的附加仅回环 Host 服务。随附的 `web` 和 `web-codex` profile template 包含其 bundle，精确匹配安装所有者的 profile manifest 会升级为这些 tuple，但不会改变自定义 bundle list。原有 `/` Chat surface、session 和 client feature rows 仍是默认内容；仪表板只增加独立的 Tasks route 和 Chat/Tasks navigation。

每个执行器启动独立运行。Pi 通过受支持的 `auth check --no-refresh --credentials --json` 命令读取缓存的 OpenAI Codex bearer，并通过临时 provider override 接收它；认证过期时任务失败，不刷新永久凭据。Codex 对配置的 auth 源进行没有刷新权限的 staging，并将其复制到 sandbox 临时区域下的可写逐次运行 `CODEX_HOME`，因此运行无法轮换永久凭据；staging 凭据值会从捕获输出中脱敏。Pi 对所需运行时状态使用相同的临时区域模式，将文件工具限制在副本工作区内，而且没有 shell 工具。Codex 使用临时严格配置和命名文件系统权限，禁止读取原项目、私有快照和运行时，允许副本工作区写入，并禁用子命令网络。OpenClaw 从单独管理的隔离配置运行，使容器用户匹配 host `uid:gid` 并禁用容器网络；受保护的 launcher 会删除其工作区 mount 精确选择的 Docker 容器，匹配的所有权允许在更改审查前删除生成的 `.openclaw` 状态。profile 补丁将凭据、可执行文件路径和 OpenClaw 配置路径保留在源代码控制之外。

项目快照准备使用 Linux 目录描述符，因此重命名源目录无法通过符号链接重定向遍历。工作目录和保留的基线文件具有独立 inode；条目数和字节数限制约束准备过程，失败或取消会删除未完成的快照。凭据及配置排除项记录在基线清单中。任务控制在启动批准被消耗后，将快照位置和精确清单 SHA-256 绑定一次；取消会阻止迟到的绑定，重启保留已有绑定而不准备替代快照。执行器以副本工作区为 cwd。sandbox 可写根包含该工作区及其后端临时区域，而基线、清单、原项目和凭据输入同级目录保持只读。执行器 launcher 与凭据暂存路径声明为私有只读根，因此即使任务存储位于 bubblewrap 遮蔽的 `/tmp` 下也能被暴露。

成功的执行器会生成一个有界清单，其中包含完整 UTF-8 前后内容、目录 mode 和 SHA-256 digest。空清单记录为 `no-change`，无需审查或应用即可关闭。对于非空更改，仪表板显示精确集合后才能提交 digest 以供应用，任务控制会在原项目变化前持久记录并消耗第二次批准。应用尝试共享一条全局链，要求每个受影响的原条目匹配其基线，并使用逐条目备份进行回滚。二进制更改、条目类型替换、受保护路径和具有多个硬链接的原文件会被拒绝。保留的快照在结束和应用后继续存在。

可选 Discord ingress 使用专用出站 bot 连接，并要求精确的用户、服务器和频道 allowlist。Discord 可以创建、检查和取消任务，但不能批准或分派任务。Discord 任务存储其已授权回复频道和成功终止交付时间，使重启恢复能够报告中断，而不会重复通知已完成工作。

OpenClaw 配置验证器仅接受文件系统和运行时两个工具组，拒绝额外的 Docker bind mount，并拒绝可能覆盖已验证默认值的逐 agent roster。profile 提供 `$DSH_HOME/command-center/openclaw-task.json` 作为默认配置路径，而 `DSH_COMMAND_CENTER_OPENCLAW_CONFIG` 可以选择其他路径。额外工具可能引入远程操作，额外挂载可能暴露无关的主机文件，而 agent 专属覆盖可以替换原本安全的 Docker 或工具设置。执行器测试验证每类添加均在 spawn 前被拒绝。

命令中心执行器不使用 DSH agent loop，也不发出 Session 事件，因此 recorded-Session snapshot harness 没有可表示该用户流程的 transcript。所属位置的仪表板测试覆盖渲染状态，真实浏览器 GIF 记录针对 loopback 服务的启动、模型执行、精确审查和应用。

## 考虑过的替代方案

- **复用现有 Pi、Codex 或 OpenClaw 会话** — 现有会话拥有无关的权限、状态和生命周期，因此无法诚实拥有任务取消和恢复。
- **直接从仪表板请求启动工作** — 请求生命周期不会保留持久准入、输出、取消或重启状态。
- **允许仪表板提交立即启动** — 每次启动需要显式持久批准，使单独提交任务无法启动执行器。启动批准只授权隔离副本；单独的 digest 绑定决定授权精确的已审查项目更改。
- **将仪表板绑定到回环之外** — 本地浏览器控制不需要网络暴露，而外部访问需要不同的认证和部署模型。
- **允许 Discord 批准或分派** — 受损 bot token 不得绕过仅浏览器的启动决定。

## 后果

仪表板可以提交、检查、批准、分派和取消项目任务，同时任务记录在进程重启后保留。allowlist Discord bot 可以提交、检查和取消任务，并报告终止结果。代理只写入明确批准项目的私有副本；审查后应用是更改原文件夹的唯一路径。任务输出是有界且脱敏的，而非完整记录，并且精确应用有意排除二进制或超大更改。
