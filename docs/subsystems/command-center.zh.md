# Software Factory

[English](command-center.md) | 中文

本地命令中心注册明确批准的项目文件夹，并将独立工作委派给已安装的 Pi、Codex 和 OpenClaw 执行器。它是单用户 WSL capability：浏览器仪表板绑定到 loopback，而可选 Discord bot 只建立出站 Gateway 连接。[`dsh-host-task-dashboard`](../../packages/host/task-dashboard/README.zh.md) 只在 Host Web server 绑定到 `127.0.0.1` 时提供 Software Factory API；Web 静态回退为 `/command-center` 提供 shell。它签发 HttpOnly SameSite session cookie，要求 mutation 使用 session CSRF token，限制 JSON 请求体大小，并通过现有 Web connection 认证 shell。组合后的 DSH Web 应用在同一 frame 中保留 Chat、session、workspace、model、permission、tool、plan、workflow、subagent、settings 和 attachment 功能。

## 所有权和持久化

[`dsh-task-control`](../../packages/workspace/task-control/README.zh.md)拥有明确的项目批准、持久任务记录、重叠路径 admission、digest 绑定批准、Discord 交付 metadata 和重启恢复。`TaskId` 是 opaque branded identifier。`TaskRequest` 指定一个已批准 workspace、执行器、来源和指令；生成的 `Task` 增加生命周期时间戳、有限 detail、启动批准、保留副本 metadata、可选精确更改状态和可选 Discord 交付状态。

活跃状态为 `pending-approval`、`queued`、`running` 和 `cancelling`；终止状态为 `succeeded`、`failed`、`cancelled` 和 `interrupted`。启动会把持久化的 `running` 或 `cancelling` 工作变为 `interrupted`，且绝不再次启动它。项目 admission 在每个活跃状态中保持占用并检测父子路径重叠，而精确应用尝试使用一条全局操作链。

启动批准是持久的仪表板决定，在准备副本前消费。来自仪表板或 Discord 的创建都会进入 `pending-approval`；Discord 没有批准或 dispatch 操作。只有任务执行确认其拥有的进程树已退出后，取消才报告 `cancelled`。成功执行器在文件有差异时会产生 `pending-review` 更改；空更改集会记录为 `no-change`，直接进入已关闭历史记录而不需要应用决定。对于非空更改，仪表板的应用决定指定 SHA-256 digest；启动时会把未完成应用报告为 `apply-interrupted`，而不会重试。

## 执行器隔离

[`dsh-task-execution`](../../packages/workspace/task-execution/README.zh.md)解析已安装的可执行文件、请求围绕私有项目副本的完整 workspace-write sandbox、启动一个独立 noninteractive 运行、捕获有限且脱敏的输出、派生有界的精确 UTF-8 更改，并结束持久任务。当完整 enforcement 不可用时，它会拒绝执行器。应用会重新验证保留的 digest 和副本工作区，拒绝原文件冲突，并在后续条目失败时尝试回滚。

Pi 在没有 session、ambient context、shell、extensions、skills、templates 或 themes 的情况下启动。受保护的 file-tool extension 解析 real path，并拒绝访问副本项目之外的位置。Codex 使用临时严格配置、workspace-write enforcement、禁用的子命令网络，以及从没有刷新权限的副本创建的逐次运行 `CODEX_HOME`。Pi 和 Codex 通过只读私有 launcher，在 sandbox 临时区域下创建所需的可写运行时状态。OpenClaw 使用受限的 host 环境和单独管理且不含逐 agent roster 的配置；一个不可覆盖的默认配置必须强制 Docker workspace 隔离、以匹配 host `uid:gid` 的用户运行容器、无容器网络、只读 root、丢弃 capabilities、无 elevation，并且只有 sandbox filesystem/runtime tools。

外层 sandbox 仅向副本工作区及其后端临时区域授予写入权限，使原项目、基线、清单和凭据输入在该层保持只读。执行器专属控制拒绝工具访问私有、运行时或原路径以及远程效果。在任务 detail 到达持久存储前，精确 staging secret 和常见凭据形式会被移除。Pi 和 Codex staging 及临时运行时目录会在进程结束后删除；OpenClaw 的受保护 launcher 删除由精确工作区 mount 选择的 Docker 容器，再于更改审查前删除生成的 `.openclaw` 状态。

## 浏览器和 Discord surface

浏览器 face 通过 route chain 在现有 shell 中渲染 Software Factory。Host face 负责 loopback API、HttpOnly SameSite dashboard session、session CSRF token、JSON 请求体限制和任务 mutation；现有 Web connection 认证 shell 和 API session。sidebar 提供普通 Software Factory link 和 `Ctrl+Shift+T` 快捷键。仪表板明确注册不重叠的项目，在每个任务上指定项目，取消等待中或运行中的任务，并在提交更改 digest 以供应用前显示完整前后内容。

可选 Discord ingress 接受精确配置用户发来的 direct message，并且仅在 author、server 和 channel 与精确配置的 allowlist 匹配时接受 guild message。它确认持久创建、公开项目和任务状态、通过同一执行所有者路由取消，并向来源 guild channel 或 direct message 报告终止结果。成功交付会持久化，因此重启不会重复通知。

## Cordis surface

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtaskcontrol--taskcontrol"></a>

### `ctx.taskControl` — `TaskControl`

Host task registry. It records requests before execution, admits one active task per overlapping approved project path, and changes unfinished work to `interrupted` during restart recovery. Executor providers own process launch and call the lifecycle methods at their durable handoff points.

```ts cordis-catalog
/**
 * Explicitly approve one canonical project directory for command-center tasks.
 * Existing approval for the same shared workspace is returned unchanged;
 * parent/child overlap with another approved project rejects.
 * @param path - Existing fully qualified project directory.
 * @returns Durable approved project.
 */
registerProject(path: string): Promise<CommandCenterProject>

/**
 * List explicitly approved command-center projects in approval order.
 * @returns Durable project approvals, newest first.
 */
listProjects(): readonly CommandCenterProject[]

/**
 * List all tasks, newest first. The caller receives immutable snapshots,
 * while storage remains the authoritative record.
 * @returns current durable task projection.
 */
list(): readonly Task[]

/**
 * Read one task without modifying it.
 * @param id - Task identity.
 * @returns current task, or `undefined` when absent.
 */
get(id: TaskId): Task | undefined

/**
 * Record a task awaiting explicit dashboard approval. One project can hold
 * only one active task, including one still awaiting approval.
 * @param request - Project, executor, entry point, and instruction.
 * @returns accepted task.
 */
create(request: TaskRequest): Promise<Task>

/**
 * Record one explicit dashboard decision and queue the task for dispatch.
 * The executor must consume this one-shot decision before it starts a child.
 * @param id - Task to queue.
 * @returns queued task with its durable dashboard decision.
 */
approve(id: TaskId): Promise<Task>

/**
 * Mark a queued task running after its executor has taken ownership. A
 * missing project directory produces a durable failed outcome instead of a
 * process launch against an unapproved path.
 * @param id - Task executor is about to own.
 * @returns running task, or a failed task when its project is unavailable.
 */
start(id: TaskId): Promise<Task>

/**
 * Consume the task's dashboard decision before preparing one executor run.
 * A decision cannot authorize another run after this call.
 * @param id - Running task about to launch its owned executor process.
 * @returns running task with its consumed decision.
 */
consumeApproval(id: TaskId): Promise<Task>

/**
 * Bind one approved running task to its prepared snapshot exactly once.
 * @param id - Task whose executor owns preparation.
 * @param copy - Private snapshot location and exact manifest fingerprint.
 * @returns Task carrying the durable snapshot reference.
 */
recordCopy(id: TaskId, copy: TaskCopyReference): Promise<Task>

/**
 * Bind the exact post-run change-set digest before successful settlement.
 * A zero-entry set records `no-change` and bypasses review/apply.
 * @param id - Running task whose stopped executor produced the changes.
 * @param changes - Exact manifest digest and file count.
 * @returns Task carrying a `pending-review` change set or a closed `no-change` outcome.
 */
recordChanges(id: TaskId, changes: Pick<TaskChangeSetReference, 'sha256' | 'count'>): Promise<Task>

/**
 * Durably bind and consume dashboard approval for one displayed change-set digest.
 * @param id - Successful task whose changes are pending review.
 * @param sha256 - Digest displayed by the dashboard and submitted for apply.
 * @returns Task marked applying before project files may change.
 */
beginApply(id: TaskId, sha256: string): Promise<Task>

/**
 * Record the terminal result of one apply attempt.
 * @param id - Task whose exact change-set approval is being consumed.
 * @param state - Successful or failed apply outcome.
 * @param detail - Bounded failure detail, or cleanup warning after a successful apply.
 * @returns Task with a terminal change-set state.
 */
finishApply(id: TaskId, state: Extract<TaskChangeState, 'applied' | 'apply-failed'>, detail?: string): Promise<Task>

/**
 * Report failed executor cleanup without claiming that owned work has stopped.
 * @param id - Running or cancelling task whose executor retains cleanup ownership.
 * @param detail - Bounded credential-safe failure description.
 * @returns Nonterminal task with its updated failure detail.
 */
recordExecutionError(id: TaskId, detail: string): Promise<Task>

/**
 * Request cancellation. Queued work stops immediately; a running executor
 * must call {@link settle} after its owned process tree has stopped.
 * @param id - Task to cancel.
 * @returns current cancellation state.
 */
cancel(id: TaskId): Promise<Task>

/**
 * Record the executor's terminal result. Only an owned running process can
 * report success or failure; only a cancelling process can report stopped.
 * @param id - Task being settled.
 * @param state - Terminal executor outcome.
 * @param detail - Safe result or error detail for later inspection.
 * @returns settled task.
 */
settle(id: TaskId, state: Exclude<TerminalTaskState, 'interrupted'>, detail?: string): Promise<Task>

/**
 * Persist successful Discord delivery of a terminal task outcome.
 * @param id - Discord-origin terminal task whose outcome was sent.
 * @returns task with its delivery timestamp.
 */
markDiscordDelivered(id: TaskId): Promise<Task>
```

Source: [`packages/workspace/task-control/src/index.ts`](../../packages/workspace/task-control/src/index.ts)

<a id="ctxtaskdashboard--taskdashboard"></a>

### `ctx.taskDashboard` — `TaskDashboard`

Local Software Factory API. The Web app serves the shell for `/command-center`; this host plugin keeps task authorization, session CSRF, and Discord ingress.

Source: [`packages/host/task-dashboard/src/index.ts`](../../packages/host/task-dashboard/src/index.ts)

<a id="ctxtaskexecution--taskexecution"></a>

### `ctx.taskExecution` — `TaskExecution`

Local task executor. It takes ownership only after a dashboard-approved task reached `queued`, wraps every child in a full workspace-write sandbox, and retains bounded redacted diagnostics in the durable task record.

```ts cordis-catalog
/**
 * Launch a queued, dashboard-approved task. The process runs only in its
 * private project copy and remains owned until a terminal record is durable.
 * The retained snapshot is bound to the task before any executor starts.
 * @param id - Task selected by the dashboard dispatcher.
 * @returns running task, or a failed task if pre-launch setup fails.
 */
async run(id: TaskId): Promise<Task>

/**
 * Cancel a queued task or terminate a running executor tree and wait for the
 * durable cancelled result. Returning means no owned child process remains.
 * @param id - Task to stop.
 * @returns durable terminal task.
 */
async cancel(id: TaskId): Promise<Task>

/**
 * Read the exact digest-bound changes produced by a successful task.
 * @param id - Settled task selected in the dashboard.
 * @returns Verified complete UTF-8 before/after review data; an empty set represents `no-change`.
 */
async review(id: TaskId): Promise<TaskChangeSet>

/**
 * Consume dashboard approval for one non-empty exact change-set digest and apply it once.
 * A `no-change` outcome cannot enter apply. Conflicting original files reject
 * without replacing user work. Apply attempts are globally serialized because
 * registered project directories may overlap.
 * @param id - Successful task whose staged changes were displayed.
 * @param sha256 - Exact displayed change-set digest.
 * @returns Task carrying the terminal apply state.
 */
apply(id: TaskId, sha256: string): Promise<Task>
```

Source: [`packages/workspace/task-execution/src/index.ts`](../../packages/workspace/task-execution/src/index.ts)
<!-- END GENERATED cordis-surface -->
