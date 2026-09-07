# Agent Note：侧边栏中的全局路由导航

Status: implemented

[English](2026-09-06-conversation-route-navigation-slot.md) | 中文

## 问题

Software Factory dashboard 是全局浏览器路由，不是 Conversation View。把它的链接放在 Conversation tabs 旁边，会将全局导航与按 Session 切换的 View 控件混在一起，并让位置依赖 Conversation header。

## 决策

`ui-sidebar` 声明 root-scoped 的 `sidebar.primary.action` list slot，位置在 New Session 与 workspace/session 浏览器之间。sidebar 负责行布局，并传递 wide/rail 状态及主题兼容的 class。路由贡献者保持普通 link 语义，不冒充 tab。

`@deepseek-ai/dsh-host-task-dashboard` 具有 browser face。该 face 通过 sidebar slot 注册本地化的 Software Factory 导航，并通过 shell 的 route chain 选择 `/command-center`；Host face 只贡献 API，不向 Web index 注入固定 HTML。依赖策略继续将这个拥有服务的包分类为 configured Host，因此包同时发布 browser entry 不会展平其 Host 服务 peer。

## 备选方案

**将 Software Factory 注册为 Conversation View。** 拒绝，因为 `/command-center` 是具有独立 API 状态的全局路由，不是由 `conversation.view` 渲染或按 Session 选择的目标。

**在 Conversation header 中渲染 Software Factory。** 拒绝，因为 header 属于 Session，tab row 表示 Conversation Views。全局访问入口应属于 layout-owned sidebar。

**保留独立 HTML 路由并调整偏移。** 拒绝，因为重复的 shell markup 会与 DSH 主题、导航、响应式布局和可访问性行为逐渐分离。

**使用浏览器 DOM 代码移动独立内容。** 拒绝，因为它依赖另一个包的私有 DOM 结构，并绕过 slot ownership model。

## 后果

Software Factory 在展开 sidebar、折叠 rail 图标和 `Ctrl+Shift+T` 中可用；它们使用主题 token 与本地化可访问名称。该 link 不依赖当前 Session；未组合 task-dashboard browser package 时才不存在。路由内容保持在 AppFrame 内，因此 shell 导航和响应式行为与 Chat 共享。Workspace 浏览器发起的用户主动 Session 打开操作在其他 route 占据中心区时会返回 `/`；自动启动选择不改变当前 route，因此 sidebar 中的 Session 点击会显示所选 Chat session。

加入 browser face 后，task-dashboard 成为具有显式 face-specific TypeScript programs 和 client bundle 的 Host/Client 包。不组合 task-dashboard 的 composition 不会获得 Software Factory 路由入口。
