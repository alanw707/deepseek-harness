import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import TaskControl, {
  TaskApprovalError,
  TaskId,
  TaskNotFoundError,
  TaskProjectBusyError,
  TaskTransitionError,
  taskRecord,
  isActiveTaskState,
  isTerminalTaskState,
} from '../src/index.ts'
import type { ProjectRecord, TaskRecord } from '../src/index.ts'

interface WorkspaceState {
  registered: boolean
  status: 'ok' | 'missing-dir'
  paths: Record<string, string>
}

interface Harness {
  readonly ctx: Context
  readonly fiber: { dispose(): Promise<void> }
  readonly state: WorkspaceState
  readonly pool: MemoryMediaPool
  readonly taskControl: TaskControl
}

interface TaskRecordTable {
  put(id: ReturnType<typeof TaskId>, value: TaskRecord): Promise<void>
}

interface ProjectRecordTable {
  put(id: WorkspaceId, value: ProjectRecord): Promise<void>
}

function taskTable(control: TaskControl): TaskRecordTable {
  return (control as unknown as { table: TaskRecordTable }).table
}

function projectTable(control: TaskControl): ProjectRecordTable {
  return (control as unknown as { projectTable: ProjectRecordTable }).projectTable
}

async function harness(pool = new MemoryMediaPool()): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  const state: WorkspaceState = {
    registered: true,
    status: 'ok',
    paths: { project: '/project', 'project-2': '/project-2' },
  }
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => state.registered ? {
      path: state.paths[id] ?? `/${id}`,
      status: async () => state.status,
    } : undefined,
    create: async (path: string) => {
      const existing = Object.entries(state.paths).find(([, value]) => value === path)
      const id = (existing?.[0] ?? `project-${String(Object.keys(state.paths).length + 1)}`) as WorkspaceId
      state.paths[id] = path
      return { id, title: path.split('/').at(-1) ?? path, path, status: async () => state.status }
    },
  } as never)
  const fiber = await ctx.plugin(TaskControl)
  const approvedAt = '2026-01-01T00:00:00.000Z'
  await projectTable(ctx.taskControl).put('project' as WorkspaceId, { title: 'project', path: '/project', approvedAt })
  await projectTable(ctx.taskControl).put('project-2' as WorkspaceId, { title: 'project-2', path: '/project-2', approvedAt })
  return { ctx, fiber, state, pool, taskControl: ctx.taskControl }
}

function request(instruction = 'inspect the project') {
  return {
    workspaceId: 'project' as WorkspaceId,
    executor: 'pi' as const,
    origin: 'dashboard' as const,
    instruction,
  }
}

const activeStates = ['pending-approval', 'queued', 'running', 'cancelling'] as const
const terminalStates = ['succeeded', 'failed', 'cancelled', 'interrupted'] as const

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

describe('TaskControl task admission', () => {
  it('persists only explicit non-overlapping project approvals', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    expect(result.taskControl.listProjects().map(project => project.id)).toEqual(['project-2', 'project'])
    await expect(result.taskControl.registerProject('.')).rejects.toThrow('must be absolute')
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-control-project-'))
    disposals.push(() => rm(root, { recursive: true, force: true }))
    const approved = await result.taskControl.registerProject(root)
    expect(approved).toMatchObject({ path: root, title: root.split('/').at(-1) })
    expect(typeof approved.approvedAt).toBe('string')
    await expect(result.taskControl.registerProject(root)).resolves.toEqual(approved)
    const nested = join(root, 'nested')
    await mkdir(nested)
    await expect(result.taskControl.registerProject(nested)).rejects.toThrow('overlaps approved project')
    await expect(result.taskControl.create({ ...request(), workspaceId: 'unapproved' as WorkspaceId })).rejects.toThrow('not approved')
  })

  it('binds a consumed run to one immutable snapshot and retains it after restart', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())
    const copy = { root: '/private/task', original: '/project', manifestSha256: 'a'.repeat(64) }
    await expect(result.taskControl.recordCopy(task.id, copy)).rejects.toBeInstanceOf(TaskTransitionError)
    await result.taskControl.approve(task.id)
    await result.taskControl.start(task.id)
    await expect(result.taskControl.recordCopy(task.id, copy)).rejects.toBeInstanceOf(TaskTransitionError)
    await result.taskControl.consumeApproval(task.id)
    const outcomes = await Promise.allSettled([
      result.taskControl.recordCopy(task.id, copy),
      result.taskControl.recordCopy(task.id, { ...copy, manifestSha256: 'b'.repeat(64) }),
    ])
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { copy } })
    const duplicate = outcomes[1]
    if (duplicate?.status !== 'rejected') throw new Error('duplicate snapshot binding was accepted')
    expect(duplicate.reason).toBeInstanceOf(TaskTransitionError)
    await result.fiber.dispose()
    const fiber = await result.ctx.plugin(TaskControl)
    disposals.push(() => fiber.dispose())
    expect(result.ctx.taskControl.get(task.id)).toMatchObject({ state: 'interrupted', copy })
    await expect(result.ctx.taskControl.recordCopy(task.id, copy)).rejects.toBeInstanceOf(TaskTransitionError)
  })

  it('binds one exact change approval and reports interrupted apply work after restart', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())
    const copy = { root: '/private/task', original: '/project', manifestSha256: 'a'.repeat(64) }
    await expect(result.taskControl.recordChanges(task.id, { sha256: 'b'.repeat(64), count: 1 })).rejects.toBeInstanceOf(TaskTransitionError)
    await result.taskControl.approve(task.id)
    await result.taskControl.start(task.id)
    await result.taskControl.consumeApproval(task.id)
    await result.taskControl.recordCopy(task.id, copy)
    const changed = await result.taskControl.recordChanges(task.id, { sha256: 'b'.repeat(64), count: 1 })
    expect(changed.copy?.changes).toEqual({ sha256: 'b'.repeat(64), count: 1, state: 'pending-review' })
    await expect(result.taskControl.recordChanges(task.id, { sha256: 'c'.repeat(64), count: 2 })).rejects.toBeInstanceOf(TaskTransitionError)
    await expect(result.taskControl.beginApply(task.id, 'b'.repeat(64))).rejects.toBeInstanceOf(TaskTransitionError)
    await result.taskControl.settle(task.id, 'succeeded')
    await expect(result.taskControl.beginApply(task.id, 'c'.repeat(64))).rejects.toBeInstanceOf(TaskTransitionError)
    const applying = await result.taskControl.beginApply(task.id, 'b'.repeat(64))
    expect(applying.copy?.changes?.state).toBe('applying')
    expect(typeof applying.copy?.changes?.approval?.approvedAt).toBe('string')
    expect(typeof applying.copy?.changes?.approval?.consumedAt).toBe('string')
    await expect(result.taskControl.beginApply(task.id, 'b'.repeat(64))).rejects.toBeInstanceOf(TaskTransitionError)
    const applied = await result.taskControl.finishApply(task.id, 'applied')
    expect(applied.copy?.changes?.state).toBe('applied')
    expect(typeof applied.copy?.changes?.appliedAt).toBe('string')
    await expect(result.taskControl.finishApply(task.id, 'apply-failed')).rejects.toBeInstanceOf(TaskTransitionError)

    const failed = await result.taskControl.create({ ...request('failed apply'), workspaceId: 'project-2' as WorkspaceId })
    await result.taskControl.approve(failed.id)
    await result.taskControl.start(failed.id)
    await result.taskControl.consumeApproval(failed.id)
    await result.taskControl.recordCopy(failed.id, { ...copy, root: '/private/failed' })
    await result.taskControl.recordChanges(failed.id, { sha256: 'e'.repeat(64), count: 1 })
    await result.taskControl.settle(failed.id, 'succeeded')
    await result.taskControl.beginApply(failed.id, 'e'.repeat(64))
    await expect(result.taskControl.finishApply(failed.id, 'apply-failed', 'project conflict')).resolves.toMatchObject({
      copy: { changes: { state: 'apply-failed', detail: 'project conflict' } },
    })

    const interrupted = await result.taskControl.create({ ...request('second task'), workspaceId: 'project-2' as WorkspaceId })
    await result.taskControl.approve(interrupted.id)
    await result.taskControl.start(interrupted.id)
    await result.taskControl.consumeApproval(interrupted.id)
    await result.taskControl.recordCopy(interrupted.id, { ...copy, root: '/private/second' })
    await result.taskControl.recordChanges(interrupted.id, { sha256: 'd'.repeat(64), count: 1 })
    await result.taskControl.settle(interrupted.id, 'succeeded')
    await result.taskControl.beginApply(interrupted.id, 'd'.repeat(64))
    await result.fiber.dispose()
    const fiber = await result.ctx.plugin(TaskControl)
    disposals.push(() => fiber.dispose())
    const interruptedChanges = result.ctx.taskControl.get(interrupted.id)?.copy?.changes
    expect(interruptedChanges?.state).toBe('apply-interrupted')
    expect(interruptedChanges?.detail).toContain('inspect the project')
  })

  it('records a successful run with no changes without creating review work', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request('no changes'))
    const copy = { root: '/private/no-change', original: '/project', manifestSha256: 'a'.repeat(64) }
    await result.taskControl.approve(task.id)
    await result.taskControl.start(task.id)
    await result.taskControl.consumeApproval(task.id)
    await result.taskControl.recordCopy(task.id, copy)
    const unchanged = await result.taskControl.recordChanges(task.id, { sha256: 'f'.repeat(64), count: 0 })
    expect(unchanged.copy?.changes).toEqual({ sha256: 'f'.repeat(64), count: 0, state: 'no-change' })
    await result.taskControl.settle(task.id, 'succeeded')
    await expect(result.taskControl.beginApply(task.id, 'f'.repeat(64))).rejects.toBeInstanceOf(TaskTransitionError)
  })

  it('retains cleanup errors without making running or cancelling work terminal', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())
    await expect(result.taskControl.recordExecutionError(task.id, 'cleanup blocked')).rejects.toBeInstanceOf(TaskTransitionError)
    await result.taskControl.approve(task.id)
    await result.taskControl.start(task.id)
    await expect(result.taskControl.recordExecutionError(task.id, 'cleanup blocked')).resolves.toMatchObject({
      state: 'running', detail: 'cleanup blocked',
    })
    await result.taskControl.cancel(task.id)
    await expect(result.taskControl.recordExecutionError(task.id, 'retry blocked')).resolves.toMatchObject({
      state: 'cancelling', detail: 'retry blocked',
    })
    await result.taskControl.settle(task.id, 'cancelled')
    await expect(result.taskControl.recordExecutionError(task.id, 'late error')).rejects.toBeInstanceOf(TaskTransitionError)
  })

  it('does not attach a snapshot when cancellation wins preparation', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())
    await result.taskControl.approve(task.id)
    await result.taskControl.start(task.id)
    await result.taskControl.consumeApproval(task.id)
    await result.taskControl.cancel(task.id)
    await expect(result.taskControl.recordCopy(task.id, {
      root: '/private/task', original: '/project', manifestSha256: 'a'.repeat(64),
    })).rejects.toBeInstanceOf(TaskTransitionError)
    expect(result.taskControl.get(task.id)?.copy).toBeUndefined()
  })

  it.each([
    { root: 'relative', original: '/project', manifestSha256: 'a'.repeat(64) },
    { root: '/private/task', original: 'relative', manifestSha256: 'a'.repeat(64) },
    { root: '/private/task', original: '/project', manifestSha256: 'invalid' },
  ])('rejects invalid durable snapshot references', (copy) => {
    expect(taskRecord.safeParse({
      ...request(), state: 'running', createdAt: 'now', updatedAt: 'now', copy,
    }).success).toBe(false)
  })

  it('persists a trimmed task and exposes it in newest-first order', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const first = await result.taskControl.create(request('  first task  '))
    const second = await result.taskControl.create({ ...request('second task'), workspaceId: 'project-2' as WorkspaceId })

    expect(first).toMatchObject({ instruction: 'first task', state: 'pending-approval' })
    expect(second).toMatchObject({ instruction: 'second task', state: 'pending-approval' })
    expect(result.taskControl.get(first.id)).toEqual(first)
    expect(result.taskControl.list()).toEqual(expect.arrayContaining([first, second]))
  })

  it('breaks identical task creation timestamps by descending task id', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const table = taskTable(result.taskControl)
    const record: TaskRecord = {
      workspaceId: 'project' as WorkspaceId,
      executor: 'pi',
      origin: 'dashboard',
      instruction: 'same timestamp',
      state: 'succeeded',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await table.put(TaskId('a'), record)
    await table.put(TaskId('b'), record)

    expect(result.taskControl.list().map(task => task.id)).toEqual([TaskId('b'), TaskId('a')])
  })

  it('rejects blank, missing, unavailable, and overlapping project requests', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    await expect(result.taskControl.create(request('   '))).rejects.toThrow(/must not be blank/)

    result.state.registered = false
    await expect(result.taskControl.create(request())).rejects.toThrow(/not registered/)
    result.state.registered = true
    result.state.status = 'missing-dir'
    await expect(result.taskControl.create(request())).rejects.toThrow(/directory is unavailable/)
    result.state.status = 'ok'

    const task = await result.taskControl.create(request())
    await expect(result.taskControl.create(request('another task'))).rejects.toBeInstanceOf(TaskProjectBusyError)
    result.state.paths['project-2'] = '/project/nested'
    await projectTable(result.taskControl).put('project-2' as WorkspaceId, {
      title: 'nested', path: '/project/nested', approvedAt: '2026-01-01T00:00:00.000Z',
    })
    await expect(result.taskControl.create({
      ...request('nested project task'), workspaceId: 'project-2' as WorkspaceId,
    })).rejects.toBeInstanceOf(TaskProjectBusyError)
    await result.taskControl.cancel(task.id)
    await expect(result.taskControl.create(request('another task'))).resolves.toMatchObject({ state: 'pending-approval' })
  })

  it('serializes simultaneous project admission attempts', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const outcomes = await Promise.allSettled([
      result.taskControl.create(request('first concurrent task')),
      result.taskControl.create(request('second concurrent task')),
    ])

    expect(outcomes.map(outcome => outcome.status)).toEqual(['fulfilled', 'rejected'])
    const rejected = outcomes[1]
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(TaskProjectBusyError)
  })

  it('rejects reads before startup and reports unknown task ids', async () => {
    const control = new TaskControl(new Context())
    expect(() => control.list()).toThrow(/not started/)
    expect(() => control.get(TaskId('missing'))).toThrow(/not started/)

    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    await expect(result.taskControl.approve(TaskId('missing'))).rejects.toBeInstanceOf(TaskNotFoundError)
  })
})

describe('TaskControl lifecycle', () => {
  it('requires approval, starts only in an available registered project, and settles a normal run', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())

    await expect(result.taskControl.start(task.id)).rejects.toBeInstanceOf(TaskTransitionError)
    await expect(result.taskControl.consumeApproval(task.id)).rejects.toBeInstanceOf(TaskTransitionError)
    const queued = await result.taskControl.approve(task.id)
    expect(queued.state).toBe('queued')
    expect(typeof queued.approval?.approvedAt).toBe('string')
    await expect(result.taskControl.approve(task.id)).rejects.toBeInstanceOf(TaskTransitionError)

    const running = await result.taskControl.start(task.id)
    expect(running.state).toBe('running')
    const consumed = await result.taskControl.consumeApproval(task.id)
    expect(typeof consumed.approval?.approvedAt).toBe('string')
    expect(typeof consumed.approval?.consumedAt).toBe('string')
    await expect(result.taskControl.consumeApproval(task.id)).rejects.toBeInstanceOf(TaskApprovalError)
    const complete = await result.taskControl.settle(task.id, 'succeeded')
    expect(complete).toMatchObject({ state: 'succeeded' })
    await expect(result.taskControl.settle(task.id, 'failed')).rejects.toBeInstanceOf(TaskTransitionError)
  })

  it('persists Discord reply delivery across terminal task reads', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create({
      ...request(),
      origin: 'discord',
      discordChannelId: '123456789012345678',
    })
    expect(task.discord).toEqual({ channelId: '123456789012345678' })
    await result.taskControl.cancel(task.id)
    const delivered = await result.taskControl.markDiscordDelivered(task.id)
    expect(delivered.discord?.channelId).toBe('123456789012345678')
    expect(typeof delivered.discord?.deliveredAt).toBe('string')

    const dashboardTask = await result.taskControl.create({ ...request(), workspaceId: 'project-2' as WorkspaceId })
    await expect(result.taskControl.markDiscordDelivered(dashboardTask.id)).rejects.toBeInstanceOf(TaskTransitionError)
  })

  it('rejects a running legacy record without dashboard approval', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const table = taskTable(result.taskControl)
    await table.put(TaskId('unapproved'), {
      workspaceId: 'project' as WorkspaceId,
      executor: 'pi',
      origin: 'dashboard',
      instruction: 'legacy task',
      state: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    await expect(result.taskControl.consumeApproval(TaskId('unapproved'))).rejects.toBeInstanceOf(TaskApprovalError)
  })

  it('records workspace disappearance as a failed queued task', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())
    await result.taskControl.approve(task.id)
    result.state.status = 'missing-dir'

    await expect(result.taskControl.start(task.id)).resolves.toMatchObject({
      state: 'failed',
      detail: 'registered project directory is unavailable',
    })
  })

  it('records project removal as a failed queued task', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())
    await result.taskControl.approve(task.id)
    result.state.registered = false

    await expect(result.taskControl.start(task.id)).resolves.toMatchObject({ state: 'failed' })
  })

  it('cancels waiting work, requests running cancellation once, and retains every terminal result', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const waiting = await result.taskControl.create(request())
    await expect(result.taskControl.cancel(waiting.id)).resolves.toMatchObject({
      state: 'cancelled',
      detail: 'cancelled before executor start',
    })
    await expect(result.taskControl.cancel(waiting.id)).resolves.toMatchObject({ state: 'cancelled' })

    const next = await result.taskControl.create(request())
    await result.taskControl.approve(next.id)
    await result.taskControl.start(next.id)
    await expect(result.taskControl.cancel(next.id)).resolves.toMatchObject({ state: 'cancelling' })
    await expect(result.taskControl.cancel(next.id)).resolves.toMatchObject({ state: 'cancelling' })
    await expect(result.taskControl.settle(next.id, 'cancelled', 'executor process tree exited')).resolves.toMatchObject({
      state: 'cancelled',
      detail: 'executor process tree exited',
    })
  })

  it('rejects terminal results that do not match the active state', async () => {
    const result = await harness()
    disposals.push(() => result.fiber.dispose())
    const task = await result.taskControl.create(request())
    await result.taskControl.approve(task.id)
    await result.taskControl.start(task.id)
    await expect(result.taskControl.settle(task.id, 'cancelled')).rejects.toBeInstanceOf(TaskTransitionError)
    await result.taskControl.cancel(task.id)
    await expect(result.taskControl.settle(task.id, 'succeeded')).rejects.toBeInstanceOf(TaskTransitionError)
  })

  it('marks running and cancellation-requested tasks interrupted after restart', async () => {
    const result = await harness()
    const running = await result.taskControl.create(request())
    await result.taskControl.approve(running.id)
    await result.taskControl.start(running.id)
    await result.taskControl.cancel(running.id)
    const settled = await result.taskControl.create({ ...request('finished run'), workspaceId: 'project-2' as WorkspaceId })
    await result.taskControl.approve(settled.id)
    await result.taskControl.start(settled.id)
    await result.taskControl.settle(settled.id, 'succeeded')
    await result.fiber.dispose()

    const fiber = await result.ctx.plugin(TaskControl)
    disposals.push(() => fiber.dispose())
    expect(result.ctx.taskControl.get(running.id)).toMatchObject({
      state: 'interrupted',
      detail: 'command-center process restarted before the executor settled',
    })
    expect(result.ctx.taskControl.get(settled.id)).toMatchObject({ state: 'succeeded' })
  })
})

describe('Task state helpers', () => {
  it('rejects project access before storage startup', () => {
    const control = Object.create(TaskControl.prototype) as TaskControl
    expect(() => control.listProjects()).toThrow('task control is not started yet')
  })

  it('separates active project-slot states from terminal states', () => {
    for (const state of activeStates) {
      expect(isActiveTaskState(state)).toBe(true)
      expect(isTerminalTaskState(state)).toBe(false)
    }
    for (const state of terminalStates) {
      expect(isActiveTaskState(state)).toBe(false)
      expect(isTerminalTaskState(state)).toBe(true)
    }
  })
})
