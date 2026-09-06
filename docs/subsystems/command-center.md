# Local Command Center

English | [中文](command-center.zh.md)

The local command center registers explicitly approved project folders and delegates independent work to installed Pi, Codex, and OpenClaw executors. It is a single-user WSL capability: the browser dashboard binds to loopback, while the optional Discord bot makes only an outbound Gateway connection. The [task-ownership Agent Note](../../.agents/notes/implemented/architecture/2026-09-05-command-center-task-ownership.md) owns the design, and the [setup guide](../user/guide/command-center.md) owns deployment and operator policy. The command center mounts alongside the composed DSH Web application: `/` remains the original Chat surface with its sessions and major client features, while `/command-center` is the separate executor Tasks surface.

## Ownership and persistence

[`dsh-task-control`](../../packages/workspace/task-control/README.md) owns explicit project approvals, the durable task record, overlapping-path admission, digest-bound approvals, Discord delivery metadata, and restart recovery. A `TaskId` is an opaque branded identifier. A `TaskRequest` names one approved workspace, executor, origin, and instruction; the resulting `Task` adds lifecycle timestamps, bounded detail, launch approval, retained-copy metadata, optional exact-change state, and optional Discord delivery state.

The active states are `pending-approval`, `queued`, `running`, and `cancelling`; terminal states are `succeeded`, `failed`, `cancelled`, and `interrupted`. Startup changes persisted `running` or `cancelling` work to `interrupted` and never starts it again. Project admission remains occupied through every active state and detects parent/child overlap, while exact apply attempts use one global operation chain.

Launch approval is a durable dashboard decision consumed before copy preparation. Creation from either dashboard or Discord enters `pending-approval`; Discord has no approval or dispatch operation. Cancellation reports `cancelled` only after task execution confirms that its owned process tree exited. A successful executor produces `pending-review` changes; the dashboard's apply decision names their SHA-256 digest, and startup reports an unfinished apply as `apply-interrupted` without retrying it.

## Executor isolation

[`dsh-task-execution`](../../packages/workspace/task-execution/README.md) resolves installed executables, requests a full workspace-write sandbox around a private project copy, starts one independent noninteractive run, captures bounded redacted output, derives bounded exact UTF-8 changes, and settles the durable task. An executor is refused when full enforcement is unavailable. Apply revalidates the retained digest and copied workspace, rejects original-file conflicts, and attempts rollback if a later entry fails.

Pi starts without a session, ambient context, shell, extensions, skills, templates, or themes. A guarded file-tool extension resolves real paths and rejects access outside the copied project. Codex starts with ephemeral strict configuration, workspace-write enforcement, no child-command networking, and a per-run `CODEX_HOME` copied without refresh authority. Pi and Codex create required writable runtime state under the sandbox temporary area through a read-only private launcher. OpenClaw starts with a narrow host environment and a separately managed configuration with no per-agent roster; one non-overridable default must enforce Docker workspace isolation, a container user matching the host `uid:gid`, no container network, a read-only root, dropped capabilities, no elevation, and only sandbox filesystem/runtime tools.

The outer sandbox grants writes only to the copied workspace and its backend temporary area, leaving the original, baseline, manifests, and credential inputs read-only at that layer. Executor-specific controls deny tool access to private, runtime, or original paths and remote effects. Exact staged secrets and common credential forms are removed before task detail reaches durable storage. Pi and Codex staging and temporary runtime directories are deleted after process settlement; OpenClaw's protected launcher removes the Docker container selected by the exact workspace mount, then removes generated `.openclaw` state before change review.

## Browser and Discord surfaces

[`dsh-host-task-dashboard`](../../packages/host/task-dashboard/README.md) serves `/command-center` only when the host Web server binds to `127.0.0.1`. It issues an HttpOnly SameSite session cookie, requires a page-local CSRF token for mutations, limits JSON request size, and applies no-store and restrictive content-security headers. The composed DSH Web application remains at `/` with its existing Chat, session, workspace, model, permission, tool, plan, workflow, subagent, settings, and attachment features; the dashboard adds a Chat/Tasks link without replacing that surface. The dashboard explicitly registers non-overlapping projects, names the project on each task, cancels waiting or running tasks, and displays complete before/after changes before it submits their digest for apply.

The optional Discord ingress accepts commands only when the author, server, and channel match exact configured allowlists. It acknowledges durable creation, exposes project and task status, routes cancellation through the same execution owner, and reports terminal outcomes to the originating allowed channel. Successful delivery is persisted so restart does not repeat a notification.

## Cordis surface

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @param id - Running task whose stopped executor produced the changes.
 * @param changes - Exact manifest digest and file count.
 * @returns Task carrying a pending-review change set.
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

Local command-center dashboard. It issues opaque HttpOnly browser sessions, requires a per-page CSRF value for every mutation, and serves no route when the Host is not bound to loopback.

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
 * @returns Verified complete UTF-8 before/after review data.
 */
async review(id: TaskId): Promise<TaskChangeSet>

/**
 * Consume dashboard approval for one exact change-set digest and apply it once.
 * Conflicting original files reject without replacing user work. Apply attempts
 * are globally serialized because registered project directories may overlap.
 * @param id - Successful task whose staged changes were displayed.
 * @param sha256 - Exact displayed change-set digest.
 * @returns Task carrying the terminal apply state.
 */
apply(id: TaskId, sha256: string): Promise<Task>
```

Source: [`packages/workspace/task-execution/src/index.ts`](../../packages/workspace/task-execution/src/index.ts)
<!-- END GENERATED cordis-surface -->
