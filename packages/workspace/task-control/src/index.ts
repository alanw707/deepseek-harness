/**
 * Durable, project-serialized command-center task lifecycle.
 * @module @deepseek-ai/dsh-task-control
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { realpathNormalize, type Workspace } from '@deepseek-ai/dsh-workspace'
import { taskControlDomainSpec } from './spec.ts'
import type { ProjectRecord, TaskRecord } from './spec.ts'
import type {
  ActiveTaskState,
  CommandCenterProject,
  Task,
  TaskChangeSetReference,
  TaskChangeState,
  TaskCopyReference,
  TaskId as TaskIdBrand,
  TaskRequest,
  TaskState,
  TerminalTaskState,
} from './types.ts'

export { projectRecord, taskControlDomainSpec, taskRecord } from './spec.ts'
export type { ProjectRecord, TaskRecord } from './spec.ts'
export type {
  DiscordTaskDelivery,
  TaskApproval,
  TaskChangeApproval,
  TaskChangeSetReference,
  TaskChangeState,
  TaskCopyReference,
} from './types.ts'
export type {
  ActiveTaskState,
  CommandCenterProject,
  Task,
  TaskExecutor,
  TaskId as TaskIdBrand,
  TaskOrigin,
  TaskRequest,
  TaskState,
  TerminalTaskState,
} from './types.ts'

/** Identifies one durable task. */
export type TaskId = TaskIdBrand

/**
 * Brand a persisted or generated task identifier.
 * @param value - Persisted or generated identifier.
 * @returns Branded task identifier.
 */
export function TaskId(value: string): TaskId {
  return value as TaskId
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable command-center task registry. */
    taskControl: TaskControl
  }
}

/** A requested transition cannot follow the task's current state. */
export class TaskTransitionError extends Error {
  /** @param task - Task that rejected the transition. */
  constructor(readonly task: Task) {
    super(`task '${task.id}' cannot transition from '${task.state}'`)
    this.name = 'TaskTransitionError'
  }
}

/** No task has the supplied identity. */
export class TaskNotFoundError extends Error {
  /** @param taskId - Task identity that was not found. */
  constructor(readonly taskId: TaskId) {
    super(`task '${taskId}' does not exist`)
    this.name = 'TaskNotFoundError'
  }
}

/** A project already has a task occupying its exclusive execution slot. */
export class TaskProjectBusyError extends Error {
  /** @param task - Existing task holding the project slot. */
  constructor(readonly task: Task) {
    super(`workspace '${task.workspaceId}' already has active task '${task.id}'`)
    this.name = 'TaskProjectBusyError'
  }
}

/** A task lacks an unconsumed dashboard decision required for process launch. */
export class TaskApprovalError extends Error {
  /** @param task - Task that lacks a valid dashboard approval. */
  constructor(readonly task: Task) {
    super(`task '${task.id}' has no unconsumed dashboard approval`)
    this.name = 'TaskApprovalError'
  }
}

/**
 * Test whether a state holds a project task slot.
 * @param state - Task lifecycle state.
 * @returns Whether the state occupies the project slot.
 */
export function isActiveTaskState(state: TaskState): state is ActiveTaskState {
  return state === 'pending-approval' || state === 'queued' || state === 'running' || state === 'cancelling'
}

/**
 * Test whether a project can accept another task after this state.
 * @param state - Task lifecycle state.
 * @returns Whether the state is terminal.
 */
export function isTerminalTaskState(state: TaskState): state is TerminalTaskState {
  return !isActiveTaskState(state)
}

/**
 * Host task registry. It records requests before execution, admits one active
 * task per overlapping approved project path, and changes unfinished work to `interrupted`
 * during restart recovery. Executor providers own process launch and call the
 * lifecycle methods at their durable handoff points.
 */
export class TaskControl extends Service {
  static inject = ['storageDomain', 'workspaceRegistry']

  private table: KvTable<TaskId, TaskRecord> | undefined
  private projectTable: KvTable<Task['workspaceId'], ProjectRecord> | undefined
  private operationTail: Promise<void> = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'taskControl')
  }

  /** Open task persistence and record runs the process could not resume. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(taskControlDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'taskControl.domainClose')
    this.table = domain.table('tasks')
    this.projectTable = domain.table('projects')
    await this.enqueue(async () => {
      for (const [id, record] of this.requireTable().entries()) {
        const now = new Date().toISOString()
        if (record.state === 'running' || record.state === 'cancelling') {
          await this.replace(id, {
            ...record,
            state: 'interrupted',
            updatedAt: now,
            detail: 'command-center process restarted before the executor settled',
          })
          continue
        }
        if (record.copy?.changes?.state !== 'applying') continue
        await this.replace(id, {
          ...record,
          updatedAt: now,
          copy: {
            ...record.copy,
            changes: {
              ...record.copy.changes,
              state: 'apply-interrupted',
              detail: 'command-center process restarted while applying reviewed changes; inspect the project before continuing',
            },
          },
        })
      }
    })
  }

  /**
   * Explicitly approve one canonical project directory for command-center tasks.
   * Existing approval for the same shared workspace is returned unchanged;
   * parent/child overlap with another approved project rejects.
   * @param path - Existing fully qualified project directory.
   * @returns Durable approved project.
   */
  registerProject(path: string): Promise<CommandCenterProject> {
    return this.enqueue(async () => {
      if (!isAbsolute(path)) throw new Error('project path must be absolute')
      const canonical = await realpathNormalize(path)
      for (const [id, record] of this.requireProjectTable().entries()) {
        if (record.path === canonical) return projectFromRecord(id, record)
        if (pathsOverlap(record.path, canonical)) throw new Error(`project path overlaps approved project '${record.title}'`)
      }
      const workspace = await this.ctx.workspaceRegistry.create(canonical)
      const record: ProjectRecord = {
        title: workspace.title,
        path: workspace.path,
        approvedAt: new Date().toISOString(),
      }
      await this.requireProjectTable().put(workspace.id, record)
      return projectFromRecord(workspace.id, record)
    })
  }

  /**
   * List explicitly approved command-center projects in approval order.
   * @returns Durable project approvals, newest first.
   */
  listProjects(): readonly CommandCenterProject[] {
    return [...this.requireProjectTable().entries()]
      .map(([id, record]) => projectFromRecord(id, record))
      .sort((left, right) => right.approvedAt.localeCompare(left.approvedAt) || String(right.id).localeCompare(String(left.id)))
  }

  /**
   * List all tasks, newest first. The caller receives immutable snapshots,
   * while storage remains the authoritative record.
   * @returns current durable task projection.
   */
  list(): readonly Task[] {
    return [...this.requireTable().entries()]
      .map(([id, record]) => taskFromRecord(id, record))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || String(right.id).localeCompare(String(left.id)))
  }

  /**
   * Read one task without modifying it.
   * @param id - Task identity.
   * @returns current task, or `undefined` when absent.
   */
  get(id: TaskId): Task | undefined {
    const record = this.requireTable().get(id)
    return record === undefined ? undefined : taskFromRecord(id, record)
  }

  /**
   * Record a task awaiting explicit dashboard approval. One project can hold
   * only one active task, including one still awaiting approval.
   * @param request - Project, executor, entry point, and instruction.
   * @returns accepted task.
   */
  create(request: TaskRequest): Promise<Task> {
    return this.enqueue(async () => {
      const instruction = request.instruction.trim()
      if (instruction === '') throw new Error('task instruction must not be blank')
      const workspace = await this.requireWorkspace(request.workspaceId)
      const active = this.list().find((task) => {
        if (!isActiveTaskState(task.state)) return false
        const holder = this.ctx.workspaceRegistry.get(task.workspaceId)
        return holder !== undefined && pathsOverlap(workspace.path, holder.path)
      })
      if (active !== undefined) throw new TaskProjectBusyError(active)
      const now = new Date().toISOString()
      const id = TaskId(randomUUID())
      const record: TaskRecord = {
        workspaceId: request.workspaceId,
        executor: request.executor,
        origin: request.origin,
        instruction,
        state: 'pending-approval',
        createdAt: now,
        updatedAt: now,
        ...(request.discordChannelId === undefined ? {} : { discord: { channelId: request.discordChannelId } }),
      }
      await this.requireTable().put(id, record)
      return taskFromRecord(id, record)
    })
  }

  /**
   * Record one explicit dashboard decision and queue the task for dispatch.
   * The executor must consume this one-shot decision before it starts a child.
   * @param id - Task to queue.
   * @returns queued task with its durable dashboard decision.
   */
  approve(id: TaskId): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      if (task.state !== 'pending-approval') throw new TaskTransitionError(task)
      const now = new Date().toISOString()
      return await this.replace(id, {
        ...this.requireTable().get(id) as TaskRecord,
        state: 'queued',
        updatedAt: now,
        approval: { approvedAt: now },
      })
    })
  }

  /**
   * Mark a queued task running after its executor has taken ownership. A
   * missing project directory produces a durable failed outcome instead of a
   * process launch against an unapproved path.
   * @param id - Task executor is about to own.
   * @returns running task, or a failed task when its project is unavailable.
   */
  start(id: TaskId): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      if (task.state !== 'queued') throw new TaskTransitionError(task)
      const workspace = this.ctx.workspaceRegistry.get(task.workspaceId)
      if (workspace === undefined || await workspace.status() !== 'ok') {
        return await this.transition(task, 'failed', 'registered project directory is unavailable')
      }
      return await this.transition(task, 'running')
    })
  }

  /**
   * Consume the task's dashboard decision before preparing one executor run.
   * A decision cannot authorize another run after this call.
   * @param id - Running task about to launch its owned executor process.
   * @returns running task with its consumed decision.
   */
  consumeApproval(id: TaskId): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      if (task.state !== 'running') throw new TaskTransitionError(task)
      if (task.approval === undefined || task.approval.consumedAt !== undefined) throw new TaskApprovalError(task)
      const now = new Date().toISOString()
      return await this.replace(id, {
        ...this.requireTable().get(id) as TaskRecord,
        updatedAt: now,
        approval: { ...task.approval, consumedAt: now },
      })
    })
  }

  /**
   * Bind one approved running task to its prepared snapshot exactly once.
   * @param id - Task whose executor owns preparation.
   * @param copy - Private snapshot location and exact manifest fingerprint.
   * @returns Task carrying the durable snapshot reference.
   */
  recordCopy(id: TaskId, copy: TaskCopyReference): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      if (task.state !== 'running' || task.approval?.consumedAt === undefined || task.copy !== undefined) {
        throw new TaskTransitionError(task)
      }
      return await this.replace(id, {
        ...this.requireTable().get(id) as TaskRecord,
        updatedAt: new Date().toISOString(),
        copy,
      })
    })
  }

  /**
   * Bind the exact post-run change-set digest before successful settlement.
   * @param id - Running task whose stopped executor produced the changes.
   * @param changes - Exact manifest digest and file count.
   * @returns Task carrying a pending-review change set.
   */
  recordChanges(id: TaskId, changes: Pick<TaskChangeSetReference, 'sha256' | 'count'>): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      if (task.state !== 'running' || task.copy === undefined || task.copy.changes !== undefined) {
        throw new TaskTransitionError(task)
      }
      return await this.replace(id, {
        ...this.requireTable().get(id) as TaskRecord,
        updatedAt: new Date().toISOString(),
        copy: { ...task.copy, changes: { ...changes, state: 'pending-review' } },
      })
    })
  }

  /**
   * Durably bind and consume dashboard approval for one displayed change-set digest.
   * @param id - Successful task whose changes are pending review.
   * @param sha256 - Digest displayed by the dashboard and submitted for apply.
   * @returns Task marked applying before project files may change.
   */
  beginApply(id: TaskId, sha256: string): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      const copy = task.copy
      const changes = copy?.changes
      if (task.state !== 'succeeded' || copy === undefined || changes?.state !== 'pending-review' || changes.sha256 !== sha256) {
        throw new TaskTransitionError(task)
      }
      const now = new Date().toISOString()
      return await this.replace(id, {
        ...this.requireTable().get(id) as TaskRecord,
        updatedAt: now,
        copy: {
          ...copy,
          changes: {
            ...changes,
            state: 'applying',
            approval: { approvedAt: now, consumedAt: now },
          },
        },
      })
    })
  }

  /**
   * Record the terminal result of one apply attempt.
   * @param id - Task whose exact change-set approval is being consumed.
   * @param state - Successful or failed apply outcome.
   * @param detail - Bounded failure detail, or cleanup warning after a successful apply.
   * @returns Task with a terminal change-set state.
   */
  finishApply(id: TaskId, state: Extract<TaskChangeState, 'applied' | 'apply-failed'>, detail?: string): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      const copy = task.copy
      const changes = copy?.changes
      if (copy === undefined || changes?.state !== 'applying') throw new TaskTransitionError(task)
      const now = new Date().toISOString()
      return await this.replace(id, {
        ...this.requireTable().get(id) as TaskRecord,
        updatedAt: now,
        copy: {
          ...copy,
          changes: {
            ...changes,
            state,
            ...(state === 'applied' ? { appliedAt: now } : {}),
            ...(detail === undefined ? {} : { detail }),
          },
        },
      })
    })
  }

  /**
   * Report failed executor cleanup without claiming that owned work has stopped.
   * @param id - Running or cancelling task whose executor retains cleanup ownership.
   * @param detail - Bounded credential-safe failure description.
   * @returns Nonterminal task with its updated failure detail.
   */
  recordExecutionError(id: TaskId, detail: string): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      if (task.state !== 'running' && task.state !== 'cancelling') throw new TaskTransitionError(task)
      return await this.transition(task, task.state, detail)
    })
  }

  /**
   * Request cancellation. Queued work stops immediately; a running executor
   * must call {@link settle} after its owned process tree has stopped.
   * @param id - Task to cancel.
   * @returns current cancellation state.
   */
  cancel(id: TaskId): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      switch (task.state) {
        case 'pending-approval':
        case 'queued':
          return await this.transition(task, 'cancelled', 'cancelled before executor start')
        case 'running':
          return await this.transition(task, 'cancelling')
        case 'cancelling':
        case 'succeeded':
        case 'failed':
        case 'cancelled':
        case 'interrupted':
          return task
        /* v8 ignore next -- TaskState is closed by the durable schema. */
        default:
          return assertNever(task.state)
      }
    })
  }

  /**
   * Record the executor's terminal result. Only an owned running process can
   * report success or failure; only a cancelling process can report stopped.
   * @param id - Task being settled.
   * @param state - Terminal executor outcome.
   * @param detail - Safe result or error detail for later inspection.
   * @returns settled task.
   */
  settle(id: TaskId, state: Exclude<TerminalTaskState, 'interrupted'>, detail?: string): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      const valid = (task.state === 'running' && (state === 'succeeded' || state === 'failed'))
        || (task.state === 'cancelling' && state === 'cancelled')
      if (!valid) throw new TaskTransitionError(task)
      return await this.transition(task, state, detail)
    })
  }

  /**
   * Persist successful Discord delivery of a terminal task outcome.
   * @param id - Discord-origin terminal task whose outcome was sent.
   * @returns task with its delivery timestamp.
   */
  markDiscordDelivered(id: TaskId): Promise<Task> {
    return this.enqueue(async () => {
      const task = this.requireTask(id)
      if (!isTerminalTaskState(task.state) || task.discord === undefined) throw new TaskTransitionError(task)
      const deliveredAt = new Date().toISOString()
      return await this.replace(id, {
        ...this.requireTable().get(id) as TaskRecord,
        updatedAt: deliveredAt,
        discord: { ...task.discord, deliveredAt },
      })
    })
  }

  private requireTask(id: TaskId): Task {
    const task = this.get(id)
    if (task === undefined) throw new TaskNotFoundError(id)
    return task
  }

  private async requireWorkspace(workspaceId: Task['workspaceId']): Promise<Workspace> {
    const approved = this.requireProjectTable().get(workspaceId)
    if (approved === undefined) throw new Error(`workspace '${workspaceId}' is not approved for command-center tasks`)
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined || workspace.path !== approved.path) throw new Error(`workspace '${workspaceId}' is not registered`)
    if (await workspace.status() !== 'ok') throw new Error(`workspace '${workspaceId}' directory is unavailable`)
    return workspace
  }

  private async transition(task: Task, state: TaskState, detail?: string): Promise<Task> {
    return await this.replace(task.id, {
      ...this.requireTable().get(task.id) as TaskRecord,
      state,
      updatedAt: new Date().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    })
  }

  private async replace(id: TaskId, record: TaskRecord): Promise<Task> {
    await this.requireTable().put(id, record)
    return taskFromRecord(id, record)
  }

  private requireTable(): KvTable<TaskId, TaskRecord> {
    if (this.table === undefined) throw new Error('task control is not started yet')
    return this.table
  }

  private requireProjectTable(): KvTable<Task['workspaceId'], ProjectRecord> {
    if (this.projectTable === undefined) throw new Error('task control is not started yet')
    return this.projectTable
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}

function taskFromRecord(id: TaskId, record: TaskRecord): Task {
  return {
    id,
    workspaceId: record.workspaceId,
    executor: record.executor,
    origin: record.origin,
    instruction: record.instruction,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.approval === undefined ? {} : { approval: record.approval }),
    ...(record.detail === undefined ? {} : { detail: record.detail }),
    ...(record.discord === undefined ? {} : { discord: record.discord }),
    ...(record.copy === undefined ? {} : { copy: record.copy }),
  }
}

function projectFromRecord(id: Task['workspaceId'], record: ProjectRecord): CommandCenterProject {
  return { id, title: record.title, path: record.path, approvedAt: record.approvedAt }
}

function pathsOverlap(left: string, right: string): boolean {
  const part = relative(left, right)
  if (part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))) return true
  const reverse = relative(right, left)
  return reverse === '' || (!isAbsolute(reverse) && reverse !== '..' && !reverse.startsWith(`..${sep}`))
}

/* v8 ignore next -- TaskState is closed by the durable schema. */
function assertNever(value: never): never {
  throw new Error(`unsupported task state '${String(value)}'`)
}

export default TaskControl
