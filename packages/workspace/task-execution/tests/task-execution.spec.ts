import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { TaskId, type Task, type TaskId as TaskIdType } from '@deepseek-ai/dsh-task-control'
import TaskExecution, { safeDetail, TaskExecutionPolicyError, type Config } from '../src/index.ts'
import { createTaskChangeSet, prepareTaskCopy } from '../src/task-copy.ts'

const { getuid, getgid } = process
const HOST_DOCKER_USER = getuid === undefined || getgid === undefined ? 'unsupported' : `${String(getuid())}:${String(getgid())}`

interface Outcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

interface Harness {
  readonly ctx: Context
  readonly fiber: { dispose(): Promise<void> }
  readonly tasks: Map<TaskIdType, Task>
  readonly subprocess: {
    readonly spawns: SubprocessSpawnSpec[]
    readonly authSpawns: SubprocessSpawnSpec[]
    readonly resolves: string[]
    readonly handle: ReturnType<typeof processHandle>
    beforeResolve: (() => void) | undefined
    authOutput: string
    authExitCode: number
  }
  readonly sandbox: { policies: unknown[]; enforcement: 'full' | 'partial' }
  readonly workspace: {
    path: string
    registered: boolean
    status: 'ok' | 'missing-dir'
    beforeStatus?: () => void
    statusGate?: Promise<void>
  }
  readonly codexAuthPath: string
  readonly copiesRoot: string
}

function task(executor: Task['executor'], state: Task['state'] = 'queued'): Task {
  return {
    id: TaskId(`${executor}-task`),
    workspaceId: 'project' as WorkspaceId,
    executor,
    origin: 'dashboard',
    instruction: 'inspect only the requested project',
    state,
    ...(state === 'queued' || state === 'running' || state === 'cancelling'
      ? { approval: { approvedAt: '2026-01-01T00:00:00.000Z' } }
      : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function snapshot(result: Harness, id: TaskIdType): NonNullable<Task['copy']> {
  const copy = result.tasks.get(id)?.copy
  if (copy === undefined) throw new Error('task has no durable snapshot reference')
  return copy
}

function replacement(value: Task, state: Task['state'], detail?: string): Task {
  return {
    ...value,
    state,
    updatedAt: '2026-01-01T00:00:01.000Z',
    ...(detail === undefined ? {} : { detail }),
  }
}

function processHandle() {
  let resolveDone: (outcome: Outcome) => void = () => {}
  let rejectDone: (reason: unknown) => void = () => {}
  const done = new Promise<Outcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const handle = {
    terminated: 0,
    waited: 0,
    stdout: '',
    stderr: '',
    exited: true,
    done,
    settle: (outcome: Outcome) => { resolveDone(outcome) },
    fail: (reason: unknown) => { rejectDone(reason) },
  }
  return handle
}

function installPendingPiAuth(result: Harness): { readonly handle: ReturnType<typeof processHandle>; readonly ready: Promise<void> } {
  const handle = processHandle()
  let signalReady!: () => void
  const ready = new Promise<void>((resolve) => { signalReady = resolve })
  const originalSpawn = (spec: SubprocessSpawnSpec) => result.ctx.subprocess.spawn(spec)
  result.ctx.subprocess.spawn = (spec) => {
    if (!spec.argv.includes('auth')) return originalSpawn(spec)
    signalReady()
    return {
      pid: 3,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      done: handle.done,
      collected: {
        stdout: { readFrom: () => ({ text: handle.stdout, nextOffset: Buffer.byteLength(handle.stdout), lossy: false }) },
        stderr: { readFrom: () => ({ text: handle.stderr, nextOffset: Buffer.byteLength(handle.stderr), lossy: false }) },
      },
      terminate: () => {
        handle.terminated += 1
        handle.settle({ exitCode: null, signal: 'SIGTERM' })
      },
      waitForExit: async () => {
        handle.waited += 1
        return true
      },
    }
  }
  return { handle, ready }
}

async function harness(configOverride: Partial<Config> = {}): Promise<Harness> {
  const ctx = new Context()
  const tasks = new Map<TaskIdType, Task>()
  const handle = processHandle()
  const subprocess = {
    spawns: [] as SubprocessSpawnSpec[],
    authSpawns: [] as SubprocessSpawnSpec[],
    resolves: [] as string[],
    handle,
    beforeResolve: undefined as (() => void) | undefined,
    authOutput: JSON.stringify({ status: 'ready', provider: 'openai-codex', credentials: 'header.payload.signature' }),
    authExitCode: 0,
  }
  const sandbox = { policies: [] as unknown[], enforcement: 'full' as 'full' | 'partial' }
  ctx.provide('taskControl', {
    get: (id: TaskIdType) => tasks.get(id),
    recordExecutionError: async (id: TaskIdType, detail: string) => {
      const current = tasks.get(id)
      if (current?.state !== 'running' && current?.state !== 'cancelling') throw new Error('task is not owned')
      const next = replacement(current, current.state, detail)
      tasks.set(id, next)
      return next
    },
    recordCopy: async (id: TaskIdType, copy: NonNullable<Task['copy']>) => {
      const current = tasks.get(id)
      if (current?.state !== 'running' || current.approval?.consumedAt === undefined || current.copy !== undefined) {
        throw new Error('task cannot bind a snapshot')
      }
      const next = { ...current, copy }
      tasks.set(id, next)
      return next
    },
    recordChanges: async (id: TaskIdType, changes: { sha256: string; count: number }) => {
      const current = tasks.get(id)
      if (current?.state !== 'running' || current.copy === undefined) throw new Error('task cannot bind changes')
      const next: Task = { ...current, copy: { ...current.copy, changes: { ...changes, state: 'pending-review' } } }
      tasks.set(id, next)
      return next
    },
    beginApply: async (id: TaskIdType, sha256: string) => {
      const current = tasks.get(id)
      if (current?.state !== 'succeeded' || current.copy?.changes?.state !== 'pending-review' || current.copy.changes.sha256 !== sha256) {
        throw new Error('task changes cannot be applied')
      }
      const approval = { approvedAt: '2026-01-01T00:00:02.000Z', consumedAt: '2026-01-01T00:00:02.000Z' }
      const next: Task = { ...current, copy: { ...current.copy, changes: { ...current.copy.changes, state: 'applying', approval } } }
      tasks.set(id, next)
      return next
    },
    finishApply: async (id: TaskIdType, state: 'applied' | 'apply-failed', detail?: string) => {
      const current = tasks.get(id)
      if (current?.copy?.changes?.state !== 'applying') throw new Error('task changes are not applying')
      const next: Task = {
        ...current,
        copy: { ...current.copy, changes: { ...current.copy.changes, state, ...(detail === undefined ? {} : { detail }) } },
      }
      tasks.set(id, next)
      return next
    },
    start: async (id: TaskIdType) => {
      const current = tasks.get(id)
      if (current === undefined || current.state !== 'queued') throw new Error('task cannot start')
      const next = replacement(current, 'running')
      tasks.set(id, next)
      return next
    },
    consumeApproval: async (id: TaskIdType) => {
      const current = tasks.get(id)
      if (current?.state !== 'running' || current.approval === undefined) throw new Error('task approval cannot be consumed')
      const next = { ...current, approval: { ...current.approval, consumedAt: '2026-01-01T00:00:01.000Z' } }
      tasks.set(id, next)
      return next
    },
    settle: async (id: TaskIdType, state: 'succeeded' | 'failed' | 'cancelled', detail?: string) => {
      const current = tasks.get(id)
      if (current === undefined) throw new Error('task not found')
      if (!((current.state === 'running' && state !== 'cancelled') || (current.state === 'cancelling' && state === 'cancelled'))) {
        throw new Error('task cannot settle')
      }
      const next = replacement(current, state, detail)
      tasks.set(id, next)
      return next
    },
    cancel: async (id: TaskIdType) => {
      const current = tasks.get(id)
      if (current === undefined) throw new Error('task not found')
      const state = current.state === 'queued' ? 'cancelled' : current.state === 'running' ? 'cancelling' : current.state
      const next = replacement(current, state, state === 'cancelled' ? 'cancelled before executor start' : undefined)
      tasks.set(id, next)
      return next
    },
  } as never)
  const workspace: Harness['workspace'] = {
    path: await mkdtemp(join(tmpdir(), 'dsh-task-execution-workspace-')),
    registered: true,
    status: 'ok',
  }
  cleanup.push(() => rm(workspace.path, { recursive: true, force: true }))
  ctx.provide('workspaceRegistry', {
    get: () => workspace.registered ? {
      path: workspace.path,
      status: async () => {
        workspace.beforeStatus?.()
        await workspace.statusGate
        return workspace.status
      },
    } : undefined,
  } as never)
  ctx.provide('sandbox', {
    confine: (argv: readonly string[], policy: unknown) => {
      sandbox.policies.push(policy)
      return { argv: ['sandbox', '--', ...argv], enforcement: sandbox.enforcement }
    },
  } as never)
  ctx.provide('subprocess', {
    resolveExecutable: async (command: string) => {
      subprocess.resolves.push(command)
      subprocess.beforeResolve?.()
      return `/resolved/${command}`
    },
    spawn: (spec: SubprocessSpawnSpec) => {
      const argv = spec.argv
      if (argv.includes('auth')) {
        subprocess.authSpawns.push(spec)
        return {
          pid: 2,
          stdin: undefined,
          stdout: undefined,
          stderr: undefined,
          terminate: () => {},
          waitForExit: async () => true,
          done: Promise.resolve({ exitCode: subprocess.authExitCode, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: subprocess.authOutput }) },
            stderr: { readFrom: () => ({ text: '' }) },
          },
        }
      }
      subprocess.spawns.push(spec)
      return {
        pid: 1,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        terminate: () => {
          handle.terminated += 1
          handle.settle({ exitCode: null, signal: 'SIGTERM' })
        },
        waitForExit: async () => {
          handle.waited += 1
          return handle.exited
        },
        done: handle.done,
        collected: {
          stdout: { readFrom: () => ({ text: handle.stdout }) },
          stderr: { readFrom: () => ({ text: handle.stderr }) },
        },
      }
    },
  } as never)
  const codexAuthRoot = await mkdtemp(join(tmpdir(), 'dsh-task-execution-codex-auth-'))
  const codexAuthPath = join(codexAuthRoot, 'auth.json')
  await writeFile(codexAuthPath, JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'codex-id-token-value',
      access_token: 'codex-access-token-value',
      refresh_token: 'codex-refresh-token-value',
      account_id: 'codex-account',
    },
  }))
  cleanup.push(() => rm(codexAuthRoot, { recursive: true, force: true }))
  const copiesRoot = await mkdtemp(join(tmpdir(), 'dsh-task-execution-copies-'))
  cleanup.push(() => rm(copiesRoot, { recursive: true, force: true }))
  const config: Config = {
    copies: { directory: copiesRoot, maxEntries: 100, maxBytes: 1_000_000, excludedNames: [] },
    pi: { command: 'pi', model: 'openai-codex/gpt-5.6-sol' },
    codex: { command: 'codex', authPath: codexAuthPath },
    openclaw: { command: 'openclaw', configPath: '/missing/openclaw.json', dockerCommand: 'docker' },
    graceMs: 100,
    outputLimitBytes: 200,
    reviewLimitBytes: 10_000,
    ...configOverride,
  }
  const fiber = await ctx.plugin(TaskExecution, config)
  return { ctx, fiber, tasks, subprocess, sandbox, workspace, codexAuthPath, copiesRoot }
}

async function settled(harness_: Harness, id: TaskIdType): Promise<Task> {
  await expect.poll(() => harness_.tasks.get(id)?.state).toMatch(/^(succeeded|failed|cancelled)$/u)
  const current = harness_.tasks.get(id)
  if (current === undefined) throw new Error('settled task disappeared')
  return current
}

async function removed(path: string): Promise<void> {
  await expect.poll(async () => {
    try {
      await stat(path)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }).toBe(true)
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(action => action()))
})

describe.skipIf(process.platform !== 'linux')('TaskExecution', () => {
  it('rejects relative snapshot storage and runtime read roots at load', async () => {
    await expect(harness({ copies: {
      directory: 'relative', maxEntries: 100, maxBytes: 1000, excludedNames: [],
    } })).rejects.toThrow('must be absolute paths')
    await expect(harness({ codex: {
      command: 'codex', authPath: '/unused/auth.json', runtimeReadRoots: ['relative'],
    } })).rejects.toThrow('must be absolute paths')
  })

  it('binds the baseline before launch and retains isolated edits without changing the original', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    await writeFile(join(result.workspace.path, 'file'), 'original')
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    result.subprocess.beforeResolve = () => {
      expect(snapshot(result, queued.id).manifestSha256).toMatch(/^[a-f0-9]{64}$/u)
    }
    await result.ctx.taskExecution.run(queued.id)
    const copy = snapshot(result, queued.id)
    const cwd = result.subprocess.spawns[0]?.cwd
    expect(cwd).toBe(join(copy.root, 'workspace'))
    await writeFile(join(cwd!, 'file'), 'edited')
    expect(await readFile(join(result.workspace.path, 'file'), 'utf8')).toBe('original')
    expect(await readFile(join(copy.root, 'baseline/file'), 'utf8')).toBe('original')
    const runtime = result.subprocess.spawns[0]?.env?.PI_CODING_AGENT_DIR
    expect(runtime).toBeDefined()
    expect(runtime?.startsWith(`${cwd}/`)).toBe(false)
    result.subprocess.handle.settle({ exitCode: 0, signal: null })
    await expect(settled(result, queued.id)).resolves.toMatchObject({ state: 'succeeded' })
    await removed(runtime!)
    expect(await readFile(join(copy.root, 'workspace/file'), 'utf8')).toBe('edited')
  })

  it('applies only the exact displayed change set after a second durable approval', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    await writeFile(join(result.workspace.path, 'file'), 'original')
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    await result.ctx.taskExecution.run(queued.id)
    const copy = snapshot(result, queued.id)
    await writeFile(join(copy.root, 'workspace/file'), 'reviewed edit')
    result.subprocess.handle.settle({ exitCode: 0, signal: null })
    const succeeded = await settled(result, queued.id)
    expect(succeeded.copy?.changes).toMatchObject({ count: 1, state: 'pending-review' })

    const review = await result.ctx.taskExecution.review(queued.id)
    expect(review.changes).toHaveLength(1)
    expect(review.changes[0]).toMatchObject({ path: 'file', kind: 'modify' })
    const before = review.changes[0]?.before
    const after = review.changes[0]?.after
    if (before?.type !== 'file' || after?.type !== 'file') throw new Error('expected reviewed file contents')
    expect(before.text).toBe('original')
    expect(after.text).toBe('reviewed edit')
    await expect(result.ctx.taskExecution.apply(queued.id, '0'.repeat(64))).rejects.toThrow('cannot be applied')
    expect(await readFile(join(result.workspace.path, 'file'), 'utf8')).toBe('original')
    const applied = await result.ctx.taskExecution.apply(queued.id, review.sha256)
    expect(applied.copy?.changes?.state).toBe('applied')
    expect(applied.copy?.changes?.approval).toBeDefined()
    expect(await readFile(join(result.workspace.path, 'file'), 'utf8')).toBe('reviewed edit')
  })

  it('records an apply conflict without replacing user work or reusing approval', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    await writeFile(join(result.workspace.path, 'file'), 'original')
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    await result.ctx.taskExecution.run(queued.id)
    await writeFile(join(snapshot(result, queued.id).root, 'workspace/file'), 'staged')
    result.subprocess.handle.settle({ exitCode: 0, signal: null })
    await settled(result, queued.id)
    const review = await result.ctx.taskExecution.review(queued.id)
    await writeFile(join(result.workspace.path, 'file'), 'user work')

    const conflicted = await result.ctx.taskExecution.apply(queued.id, review.sha256)
    expect(conflicted.copy?.changes?.state).toBe('apply-failed')
    expect(conflicted.copy?.changes?.detail).toContain('changed after task preparation')
    expect(await readFile(join(result.workspace.path, 'file'), 'utf8')).toBe('user work')
    await expect(result.ctx.taskExecution.apply(queued.id, review.sha256)).rejects.toThrow('cannot be applied')
  })

  it('serializes apply attempts across overlapping registered project paths', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    await writeFile(join(result.workspace.path, 'file'), 'baseline')
    const limits = { maxEntries: 100, maxBytes: 1_000_000, excludedNames: [] }
    const firstCopy = await prepareTaskCopy(result.workspace.path, result.copiesRoot, limits)
    const secondCopy = await prepareTaskCopy(result.workspace.path, result.copiesRoot, limits)
    await writeFile(join(firstCopy.workspace, 'file'), 'first')
    await writeFile(join(secondCopy.workspace, 'file'), 'second')
    const firstChanges = await createTaskChangeSet(firstCopy, 10_000)
    const secondChanges = await createTaskChangeSet(secondCopy, 10_000)
    const first = { ...task('pi', 'succeeded'), id: TaskId('first-apply'), copy: {
      root: firstCopy.root, original: firstCopy.original, manifestSha256: firstCopy.manifestSha256,
      changes: { sha256: firstChanges.sha256, count: 1, state: 'pending-review' as const },
    } }
    const second = { ...task('pi', 'succeeded'), id: TaskId('second-apply'), copy: {
      root: secondCopy.root, original: secondCopy.original, manifestSha256: secondCopy.manifestSha256,
      changes: { sha256: secondChanges.sha256, count: 1, state: 'pending-review' as const },
    } }
    result.tasks.set(first.id, first)
    result.tasks.set(second.id, second)
    const begin = result.ctx.taskControl.beginApply.bind(result.ctx.taskControl)
    const calls: string[] = []
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ready = new Promise<void>((resolve) => { started = resolve })
    result.ctx.taskControl.beginApply = async (id, digest) => {
      calls.push(id)
      if (id === first.id) {
        started()
        await gate
      }
      return await begin(id, digest)
    }

    const firstApply = result.ctx.taskExecution.apply(first.id, firstChanges.sha256)
    const secondApply = result.ctx.taskExecution.apply(second.id, secondChanges.sha256)
    await ready
    expect(calls).toEqual([first.id])
    release()
    await expect(firstApply).resolves.toMatchObject({ copy: { changes: { state: 'applied' } } })
    await expect(secondApply).resolves.toMatchObject({ copy: { changes: { state: 'apply-failed' } } })
    expect(calls).toEqual([first.id, second.id])
    expect(await readFile(join(result.workspace.path, 'file'), 'utf8')).toBe('first')
  })

  it('refuses admission that resumes after service disposal', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    let signalReady!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => { signalReady = resolve })
    result.workspace.beforeStatus = () => { signalReady() }
    result.workspace.statusGate = new Promise<void>((resolve) => { release = resolve })
    const execution = result.ctx.taskExecution
    const run = execution.run(queued.id)
    await ready
    await result.fiber.dispose()
    release()
    await expect(run).rejects.toThrow('task executor is stopping')
    await expect(execution.run(queued.id)).rejects.toThrow('task executor is stopping')
    expect(result.tasks.get(queued.id)?.state).toBe('queued')
    expect(result.subprocess.spawns).toHaveLength(0)
    expect(await readdir(result.copiesRoot)).toEqual([])
  })

  it('keeps failed cleanup nonterminal and retries it on explicit cancellation', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    await result.ctx.taskExecution.run(queued.id)
    const spawn = result.subprocess.spawns[0]
    const runtime = spawn?.env?.PI_CODING_AGENT_DIR
    const launcher = spawn?.argv[3]
    if (runtime === undefined || launcher === undefined) throw new Error('missing Pi private runtime')
    const staging = dirname(launcher)
    await chmod(staging, 0o500)
    try {
      result.subprocess.handle.settle({ exitCode: 0, signal: null })
      await expect.poll(() => result.tasks.get(queued.id)?.detail).toMatch(/^executor cleanup failed:/u)
      expect(result.tasks.get(queued.id)?.state).toBe('running')
      await expect(result.ctx.taskExecution.cancel(queued.id)).rejects.toThrow('executor cleanup failed:')
      expect(result.tasks.get(queued.id)?.state).toBe('cancelling')
    } finally {
      await chmod(staging, 0o700)
    }
    await expect(result.ctx.taskExecution.cancel(queued.id)).resolves.toMatchObject({ state: 'cancelled' })
    await expect(stat(staging)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses unsafe copy input before authentication or executor launch', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    await symlink(result.codexAuthPath, join(result.workspace.path, 'linked-credential'))
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'failed' })
    expect(result.subprocess.authSpawns).toHaveLength(0)
    expect(result.subprocess.spawns).toHaveLength(0)
    expect(result.tasks.get(queued.id)?.copy).toBeUndefined()
    expect(await readdir(result.copiesRoot)).toEqual([])
  })

  it('removes an unbound snapshot when durable copy ownership cannot be recorded', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    result.ctx.taskControl.recordCopy = async () => { throw new Error('copy storage unavailable') }
    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({
      state: 'failed', detail: 'copy storage unavailable',
    })
    expect(await readdir(result.copiesRoot)).toEqual([])
    expect(result.subprocess.authSpawns).toHaveLength(0)
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('cancels preparation before creating or binding a task copy', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    let signalReady!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => { signalReady = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const consume = result.ctx.taskControl.consumeApproval.bind(result.ctx.taskControl)
    result.ctx.taskControl.consumeApproval = async (id) => {
      const current = await consume(id)
      signalReady()
      await gate
      return current
    }
    const run = result.ctx.taskExecution.run(queued.id)
    await ready
    const cancellation = result.ctx.taskExecution.cancel(queued.id)
    release()
    await expect(run).resolves.toMatchObject({ state: 'cancelled' })
    await expect(cancellation).resolves.toMatchObject({ state: 'cancelled' })
    expect(await readdir(result.copiesRoot)).toEqual([])
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it.each([
    'secret credential is not JSON',
    'null',
    '{}',
    JSON.stringify({ status: 'expired', provider: 'openai-codex', credentials: 'secret' }),
    JSON.stringify({ status: 'ready', provider: 'other', credentials: 'secret' }),
    JSON.stringify({ status: 'ready', provider: 'openai-codex', credentials: '' }),
    JSON.stringify({ status: 'ready', provider: 'openai-codex', credentials: 'secret value' }),
  ])('rejects unusable cached credential metadata without publishing credentials: %s', async (authOutput) => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    result.subprocess.authOutput = authOutput
    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({
      state: 'failed', detail: 'OpenAI Codex authentication returned invalid credential metadata',
    })
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('fails a missing cached login without refreshing or spawning Pi', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    result.subprocess.authExitCode = 1
    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({
      state: 'failed', detail: 'OpenAI Codex cached authentication unavailable; authenticate outside the task before retrying',
    })
    expect(result.subprocess.authSpawns[0]?.argv).toContain('--no-refresh')
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('launches Pi only after approval state and stores redacted bounded output', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)

    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'running' })
    expect(result.subprocess.spawns).toHaveLength(1)
    expect(result.subprocess.authSpawns).toHaveLength(1)
    expect(result.subprocess.authSpawns[0]).toMatchObject({
      argv: ['/resolved/pi', 'auth', 'check', '--provider', 'openai-codex', '--no-refresh', '--credentials', '--json'],
      cwd: join(snapshot(result, queued.id).root, 'workspace'),
    })
    const spawn = result.subprocess.spawns[0]!
    expect(spawn).toMatchObject({
      cwd: join(snapshot(result, queued.id).root, 'workspace'),
      graceMs: 100,
    })
    const extensionIndex = spawn.argv.indexOf('--extension')
    const guardPath = spawn.argv[extensionIndex + 1]
    if (guardPath === undefined) throw new Error('missing Pi guard path')
    expect(guardPath).toMatch(/workspace-guard\.mjs$/u)
    const launcherPath = spawn.argv[3]
    if (launcherPath === undefined) throw new Error('missing Pi runtime launcher')
    expect(launcherPath).toMatch(/runtime\.mjs$/u)
    expect(spawn.argv).toEqual([
      'sandbox', '--', process.execPath, launcherPath, 'pi', spawn.env?.PI_CODING_AGENT_DIR, '-', '/resolved/pi',
      '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
      '--extension', guardPath,
      '--model', 'openai-codex/gpt-5.6-sol', '--tools', 'read,write,edit,grep,find,ls', '--print', queued.instruction,
    ])
    expect(spawn.env).toMatchObject({
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      DSH_COMMAND_CENTER_PI_BEARER: 'header.payload.signature',
    })
    expect(spawn.env?.PI_CODING_AGENT_DIR).toMatch(/dsh-command-center-pi-/u)
    expect(result.sandbox.policies).toHaveLength(1)
    expect(result.sandbox.policies[0]).toMatchObject({
      mode: 'workspace-write', workspaceRoot: join(snapshot(result, queued.id).root, 'workspace'),
    })
    expect(result.sandbox.policies[0]).toEqual(expect.objectContaining({
      readOnlyRoots: [expect.stringMatching(/dsh-command-center-pi-/u)],
    }))
    result.subprocess.handle.stdout = 'Bearer abcdefghijklmnop'
    result.subprocess.handle.stderr = 'token=abcdefghijklmnop'
    result.subprocess.handle.settle({ exitCode: 0, signal: null })

    const complete = await settled(result, queued.id)
    expect(complete.state).toBe('succeeded')
    expect(complete.detail).toContain('Bearer [redacted]')
    expect(result.tasks.get(queued.id)?.detail).toContain('secret=[redacted]')
  })

  it('defers to durable task admission for missing, nonqueued, and unavailable projects', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    await expect(result.ctx.taskExecution.run(TaskId('missing'))).rejects.toThrow('task cannot start')

    const running = task('codex', 'running')
    result.tasks.set(running.id, running)
    await expect(result.ctx.taskExecution.run(running.id)).rejects.toThrow('task cannot start')

    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    result.workspace.registered = false
    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'running' })

    const missingDirectory = task('openclaw')
    result.tasks.set(missingDirectory.id, missingDirectory)
    result.workspace.registered = true
    result.workspace.status = 'missing-dir'
    await expect(result.ctx.taskExecution.run(missingDirectory.id)).resolves.toMatchObject({ state: 'running' })
  })

  it('does not spawn after an external terminal transition or a disappeared task', async () => {
    const terminal = await harness()
    cleanup.push(() => terminal.fiber.dispose())
    const queued = task('codex')
    terminal.tasks.set(queued.id, queued)
    terminal.subprocess.beforeResolve = () => {
      terminal.tasks.set(queued.id, replacement(queued, 'succeeded'))
    }
    await expect(terminal.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'succeeded' })
    expect(terminal.subprocess.spawns).toHaveLength(0)

    const missing = await harness()
    cleanup.push(() => missing.fiber.dispose())
    missing.tasks.set(queued.id, queued)
    missing.subprocess.beforeResolve = () => {
      missing.tasks.delete(queued.id)
    }
    await expect(missing.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'running' })
    expect(missing.subprocess.spawns).toHaveLength(0)
  })

  it('does not spawn when durable admission returns a non-running result', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    result.ctx.taskControl.start = async () => queued

    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toBe(queued)
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('uses Codex noninteractive workspace-write mode without a bypass flag', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)

    await result.ctx.taskExecution.run(queued.id)
    expect(result.subprocess.authSpawns).toHaveLength(0)
    const spawn = result.subprocess.spawns[0]
    const codexHome = spawn?.env?.CODEX_HOME
    if (spawn === undefined || codexHome === undefined) throw new Error('missing ephemeral Codex runtime')
    const launcherPath = spawn.argv[3]
    const authPath = spawn.argv[6]
    if (launcherPath === undefined || authPath === undefined) throw new Error('missing Codex private runtime staging')
    expect(spawn.argv).toEqual([
      'sandbox', '--', process.execPath, launcherPath, 'codex', codexHome, authPath, '/resolved/codex',
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check',
      '-c', 'approval_policy="never"',
      '-c', 'default_permissions="command-center"',
      '-c', `permissions.command-center.filesystem={":minimal"="read",${JSON.stringify(snapshot(result, queued.id).root)}="deny",${JSON.stringify(result.workspace.path)}="deny",${JSON.stringify(codexHome)}="deny",":workspace_roots"={"."="write"}}`,
      '-c', 'permissions.command-center.network.enabled=false',
      '-C', join(snapshot(result, queued.id).root, 'workspace'), queued.instruction,
    ])
    expect(codexHome).toMatch(/dsh-command-center-codex-/u)
    const stagedAuth = JSON.parse(await readFile(authPath, 'utf8')) as { tokens: { refresh_token: string } }
    const sourceAuth = JSON.parse(await readFile(result.codexAuthPath, 'utf8')) as { tokens: { refresh_token: string } }
    expect(stagedAuth.tokens.refresh_token).toBe('')
    expect(sourceAuth.tokens.refresh_token).toBe('codex-refresh-token-value')
    result.subprocess.handle.settle({ exitCode: 23, signal: null })
    const failed = await settled(result, queued.id)
    expect(failed.state).toBe('failed')
    expect(failed.detail).toContain('exit code: 23')
    await removed(authPath)
  })

  it('cancels waiting work without touching a subprocess', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)

    await expect(result.ctx.taskExecution.cancel(queued.id)).resolves.toMatchObject({ state: 'cancelled' })
    expect(result.subprocess.handle.terminated).toBe(0)
  })

  it('waits for the whole process tree before reporting cancellation', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    await result.ctx.taskExecution.run(queued.id)

    await expect(result.ctx.taskExecution.cancel(queued.id)).resolves.toMatchObject({ state: 'cancelled' })
    expect(result.subprocess.handle.terminated).toBe(1)
    expect(result.subprocess.handle.waited).toBe(1)
  })

  it('terminates an owned Pi authentication helper when cancellation wins startup', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    const auth = installPendingPiAuth(result)

    const run = result.ctx.taskExecution.run(queued.id)
    await auth.ready
    const cancel = result.ctx.taskExecution.cancel(queued.id)

    await expect(run).resolves.toMatchObject({ state: 'cancelled' })
    await expect(cancel).resolves.toMatchObject({ state: 'cancelled' })
    expect(auth.handle.terminated).toBe(1)
    expect(auth.handle.waited).toBe(1)
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('settles cancellation that wins while the runner resolves its executable', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    let resolveExecutable: (value: string) => void = () => {}
    let signalReady!: () => void
    const ready = new Promise<void>((resolve) => { signalReady = resolve })
    result.ctx.subprocess.resolveExecutable = async () => await new Promise((resolve) => {
      resolveExecutable = resolve
      signalReady()
    })

    const run = result.ctx.taskExecution.run(queued.id)
    await ready
    const cancel = result.ctx.taskExecution.cancel(queued.id)
    resolveExecutable('/resolved/codex')

    await expect(run).resolves.toMatchObject({ state: 'cancelled' })
    await expect(cancel).resolves.toMatchObject({ state: 'cancelled' })
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('refuses partial sandbox enforcement before spawning an executor', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    result.sandbox.enforcement = 'partial'
    const queued = task('codex')
    result.tasks.set(queued.id, queued)

    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({
      state: 'failed',
      detail: 'task executor requires a full workspace-write sandbox',
    })
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('refuses process launch when dashboard approval cannot be consumed', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    result.ctx.taskControl.consumeApproval = async () => { throw new Error('task approval cannot be consumed') }

    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({
      state: 'failed',
      detail: 'task approval cannot be consumed',
    })
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('records a process failure as cancellation when cancellation already owns the task', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    await result.ctx.taskExecution.run(queued.id)
    result.tasks.set(queued.id, replacement(result.tasks.get(queued.id)!, 'cancelling'))
    result.subprocess.handle.fail(new Error('termination transport closed'))

    await expect(settled(result, queued.id)).resolves.toMatchObject({ state: 'cancelled' })
  })

  it('records setup failure as cancellation when cancellation takes the task first', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    result.ctx.sandbox.confine = () => {
      result.tasks.set(queued.id, replacement(result.tasks.get(queued.id)!, 'cancelling'))
      throw new Error('sandbox stopped')
    }

    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'cancelled', detail: 'sandbox stopped' })
  })

  it('returns durable state when cancellation has no startup or process to stop', async () => {
    const existing = await harness()
    cleanup.push(() => existing.fiber.dispose())
    const queued = task('codex')
    existing.tasks.set(queued.id, replacement(queued, 'succeeded'))
    existing.ctx.taskControl.cancel = async () => replacement(queued, 'cancelling')
    await expect(existing.ctx.taskExecution.cancel(queued.id)).resolves.toMatchObject({ state: 'succeeded' })

    const absent = await harness()
    cleanup.push(() => absent.fiber.dispose())
    absent.ctx.taskControl.cancel = async () => replacement(queued, 'cancelling')
    await expect(absent.ctx.taskExecution.cancel(queued.id)).resolves.toMatchObject({ state: 'cancelling' })

    const cancelling = await harness()
    cleanup.push(() => cancelling.fiber.dispose())
    cancelling.tasks.set(queued.id, queued)
    cancelling.ctx.taskControl.cancel = async () => {
      const next = replacement(queued, 'cancelling')
      cancelling.tasks.set(queued.id, next)
      return next
    }
    await expect(cancelling.ctx.taskExecution.cancel(queued.id)).resolves.toMatchObject({ state: 'cancelled' })
  })

  it('reports process setup failures and process-level failures as durable task failures', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const setupFailure = task('codex')
    result.tasks.set(setupFailure.id, setupFailure)
    result.ctx.sandbox.confine = () => { throw 'sandbox setup failed' }
    await expect(result.ctx.taskExecution.run(setupFailure.id)).resolves.toMatchObject({
      state: 'failed',
      detail: 'sandbox setup failed',
    })

    const processFailure = task('pi')
    result.tasks.set(processFailure.id, processFailure)
    result.ctx.sandbox.confine = (argv: readonly string[]) => ({ argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] })
    await result.ctx.taskExecution.run(processFailure.id)
    result.subprocess.handle.fail(new Error('spawn pipe closed'))
    await expect(settled(result, processFailure.id)).resolves.toMatchObject({ state: 'failed', detail: 'Error: spawn pipe closed' })
  })

  it('stops starting and live executors during service disposal', async () => {
    const starting = await harness()
    const pi = task('pi')
    starting.tasks.set(pi.id, pi)
    const auth = installPendingPiAuth(starting)
    const run = starting.ctx.taskExecution.run(pi.id)
    await auth.ready

    await starting.fiber.dispose()
    await expect(run).resolves.toMatchObject({ state: 'cancelled' })
    expect(auth.handle.terminated).toBe(1)
    expect(auth.handle.waited).toBe(1)

    const live = await harness()
    const codex = task('codex')
    live.tasks.set(codex.id, codex)
    await live.ctx.taskExecution.run(codex.id)

    await live.fiber.dispose()
    expect(live.subprocess.handle.terminated).toBe(1)
    expect(live.tasks.get(codex.id)).toMatchObject({ state: 'cancelled' })
  })

  it('rejects review and apply when task or registered project state no longer authorizes them', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    await expect(result.ctx.taskExecution.review(queued.id)).rejects.toThrow('no successful staged changes')
    await expect(result.ctx.taskExecution.apply(TaskId('missing'), '0'.repeat(64))).rejects.toThrow('registered project is unavailable')

    await result.ctx.taskExecution.run(queued.id)
    const copy = snapshot(result, queued.id)
    await writeFile(join(copy.root, 'workspace/new'), 'change')
    result.subprocess.handle.settle({ exitCode: 0, signal: null })
    const succeeded = await settled(result, queued.id)
    const digest = succeeded.copy?.changes?.sha256
    if (digest === undefined) throw new Error('missing staged changes')

    result.workspace.registered = false
    await expect(result.ctx.taskExecution.apply(queued.id, digest)).rejects.toThrow('registered project is unavailable')
    result.workspace.registered = true
    const originalPath = result.workspace.path
    result.workspace.path = '/different'
    await expect(result.ctx.taskExecution.apply(queued.id, digest)).rejects.toThrow('no longer matches')
    result.workspace.path = originalPath
    result.workspace.status = 'missing-dir'
    await expect(result.ctx.taskExecution.apply(queued.id, digest)).rejects.toThrow('registered project is unavailable')
    result.workspace.status = 'ok'
    result.ctx.taskControl.beginApply = async () => ({ ...succeeded, copy: undefined })
    await expect(result.ctx.taskExecution.apply(queued.id, digest)).rejects.toThrow('lost its durable project copy')
  })

  it('settles cancellation or disappearance after confinement and handles incomplete process exit', async () => {
    const cancelled = await harness()
    cleanup.push(() => cancelled.fiber.dispose())
    const first = task('codex')
    cancelled.tasks.set(first.id, first)
    cancelled.ctx.sandbox.confine = (argv: readonly string[]) => {
      cancelled.tasks.set(first.id, replacement(cancelled.tasks.get(first.id)!, 'cancelling'))
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    }
    await expect(cancelled.ctx.taskExecution.run(first.id)).resolves.toMatchObject({ state: 'cancelled' })
    expect(cancelled.subprocess.spawns).toHaveLength(0)

    const disappeared = await harness()
    cleanup.push(() => disappeared.fiber.dispose())
    const second = task('codex')
    disappeared.tasks.set(second.id, second)
    disappeared.ctx.sandbox.confine = (argv: readonly string[]) => {
      disappeared.tasks.delete(second.id)
      return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    }
    await expect(disappeared.ctx.taskExecution.run(second.id)).resolves.toMatchObject({ state: 'running' })

    const incomplete = await harness()
    cleanup.push(() => incomplete.fiber.dispose())
    const third = task('codex')
    incomplete.tasks.set(third.id, third)
    await incomplete.ctx.taskExecution.run(third.id)
    incomplete.subprocess.handle.exited = false
    incomplete.subprocess.handle.settle({ exitCode: 0, signal: null })
    await expect.poll(() => incomplete.tasks.get(third.id)?.detail).toContain('process tree has not stopped')
    expect(incomplete.tasks.get(third.id)?.state).toBe('running')
    expect(incomplete.tasks.get(third.id)?.detail).toContain('cleanup failed')
    incomplete.subprocess.handle.exited = true
    await expect(incomplete.ctx.taskExecution.cancel(third.id)).resolves.toMatchObject({ state: 'cancelled' })
  })

  it('fails successful process output when staged changes cannot be reviewed and tolerates vanished records', async () => {
    const invalid = await harness()
    cleanup.push(() => invalid.fiber.dispose())
    const first = task('codex')
    invalid.tasks.set(first.id, first)
    await invalid.ctx.taskExecution.run(first.id)
    await writeFile(join(snapshot(invalid, first.id).root, 'workspace/.env'), 'protected')
    invalid.subprocess.handle.settle({ exitCode: 0, signal: null })
    const failed = await settled(invalid, first.id)
    expect(failed.state).toBe('failed')
    expect(failed.detail).toContain('change review failed')

    const vanished = await harness()
    cleanup.push(() => vanished.fiber.dispose())
    const second = task('codex')
    vanished.tasks.set(second.id, second)
    await vanished.ctx.taskExecution.run(second.id)
    vanished.tasks.delete(second.id)
    vanished.subprocess.handle.settle({ exitCode: 1, signal: null })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(vanished.tasks.has(second.id)).toBe(false)
  })

  it('handles Pi cancellation at both authentication checks', async () => {
    const before = await harness()
    cleanup.push(() => before.fiber.dispose())
    const first = task('pi')
    before.tasks.set(first.id, first)
    before.subprocess.beforeResolve = () => { before.tasks.set(first.id, replacement(first, 'succeeded')) }
    await expect(before.ctx.taskExecution.run(first.id)).resolves.toMatchObject({ state: 'succeeded' })

    const after = await harness()
    cleanup.push(() => after.fiber.dispose())
    const second = task('pi')
    after.tasks.set(second.id, second)
    const originalSpawn = after.ctx.subprocess.spawn.bind(after.ctx.subprocess)
    after.ctx.subprocess.spawn = (spec) => {
      const handle = originalSpawn(spec)
      if (spec.argv.includes('auth') && handle.collected.stdout !== undefined) {
        handle.collected.stdout.readFrom = () => {
          after.tasks.set(second.id, replacement(second, 'succeeded'))
          return { text: after.subprocess.authOutput, nextOffset: 0, lossy: false }
        }
      }
      return handle
    }
    await expect(after.ctx.taskExecution.run(second.id)).resolves.toMatchObject({ state: 'succeeded' })
  })

  it.each([
    { value: '{', message: 'cannot be read' },
    { value: '{}', message: 'is invalid' },
    { value: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'codex-api-key-value' }), message: 'running' },
    { value: JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }), message: 'is invalid' },
    { value: JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'id-value', access_token: 'access-value', account_id: 'account' } }), message: 'running' },
  ])('validates Codex credential staging: $message', async ({ value, message }) => {
    const result = await harness({ codex: { command: 'codex', authPath: '/replaced' } })
    cleanup.push(() => result.fiber.dispose())
    const authRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-case-'))
    cleanup.push(() => rm(authRoot, { recursive: true, force: true }))
    const authPath = join(authRoot, 'auth.json')
    await writeFile(authPath, value)
    ;(result.ctx.taskExecution as unknown as { config: { codex: { authPath: string } } }).config.codex.authPath = authPath
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    const outcome = await result.ctx.taskExecution.run(queued.id)
    if (message === 'running') {
      expect(outcome.state).toBe('running')
      result.subprocess.handle.settle({ exitCode: 1, signal: null })
      await settled(result, queued.id)
    } else {
      expect(outcome.state).toBe('failed')
      expect(outcome.detail).toContain(message)
    }
  })

  it('includes absolute configured Codex runtime read roots', async () => {
    const result = await harness({ codex: {
      command: 'codex', authPath: '/unused', runtimeReadRoots: ['/opt/codex-runtime'],
    } })
    cleanup.push(() => result.fiber.dispose())
    ;(result.ctx.taskExecution as unknown as { config: { codex: { authPath: string } } }).config.codex.authPath = result.codexAuthPath
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    await result.ctx.taskExecution.run(queued.id)
    expect(result.subprocess.spawns[0]?.argv.join(' ')).toContain('"/opt/codex-runtime"="read"')
    result.subprocess.handle.settle({ exitCode: 1, signal: null })
    await settled(result, queued.id)
  })

  it('handles missing Pi credential output without exposing parser diagnostics', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('pi')
    result.tasks.set(queued.id, queued)
    const originalSpawn = result.ctx.subprocess.spawn.bind(result.ctx.subprocess)
    result.ctx.subprocess.spawn = (spec) => {
      if (!spec.argv.includes('auth')) return originalSpawn(spec)
      const handle = originalSpawn(spec)
      return { ...handle, collected: {} }
    }
    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({
      state: 'failed', detail: 'OpenAI Codex authentication returned invalid credential metadata',
    })
  })

  it('refuses an OpenClaw configuration that can escape Docker task isolation', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('openclaw')
    result.tasks.set(queued.id, queued)

    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({
      state: 'failed',
      detail: 'OpenClaw task configuration cannot be parsed',
    })
    expect(result.subprocess.spawns).toHaveLength(0)
  })

  it('rejects a parseable OpenClaw configuration that omits the required policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-execution-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const configPath = join(root, 'openclaw.json')
    await writeFile(configPath, '{}')
    const result = await harness({ openclaw: { command: 'openclaw', configPath, dockerCommand: 'docker' } })
    cleanup.push(() => result.fiber.dispose())
    const queued = task('openclaw')
    result.tasks.set(queued.id, queued)

    const failed = await result.ctx.taskExecution.run(queued.id)
    expect(failed.state).toBe('failed')
    expect(failed.detail).toContain('must enforce Docker workspace isolation')
  })

  it('removes OpenClaw staging when Docker executable resolution fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-execution-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const configPath = join(root, 'openclaw.json')
    await writeFile(configPath, `{
      agents: { defaults: { sandbox: { mode: 'all', backend: 'docker', workspaceAccess: 'rw', docker: { network: 'none', user: '${HOST_DOCKER_USER}', readOnlyRoot: true, capDrop: ['ALL'] } } } },
      tools: { elevated: { enabled: false }, sandbox: { tools: { allow: ['group:fs', 'group:runtime'] } } }
    }`)
    const result = await harness({ openclaw: { command: 'openclaw', configPath, dockerCommand: 'docker' } })
    cleanup.push(() => result.fiber.dispose())
    result.ctx.subprocess.resolveExecutable = async (command) => {
      if (command === 'docker') throw new Error('Docker unavailable')
      return `/resolved/${command}`
    }
    const queued = task('openclaw')
    result.tasks.set(queued.id, queued)

    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'failed', detail: 'Docker unavailable' })
    expect((await readdir(snapshot(result, queued.id).root)).some(name => name.startsWith('.dsh-command-center-openclaw-'))).toBe(false)
  })

  it('accepts an OpenClaw configuration with Docker no-network task isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-task-execution-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const configPath = join(root, 'openclaw.json')
    await writeFile(configPath, `{
      agents: { defaults: { sandbox: { mode: 'all', backend: 'docker', workspaceAccess: 'rw', docker: { network: 'none', user: '${HOST_DOCKER_USER}', readOnlyRoot: true, capDrop: ['ALL'] } } } },
      tools: { elevated: { enabled: false }, sandbox: { tools: { allow: ['group:fs', 'group:runtime'] } } }
    }`)
    const result = await harness({ openclaw: { command: 'openclaw', configPath, dockerCommand: 'docker' } })
    cleanup.push(() => result.fiber.dispose())
    const queued = task('openclaw')
    result.tasks.set(queued.id, queued)

    await result.ctx.taskExecution.run(queued.id)
    const launcherPath = result.subprocess.spawns[0]?.argv[3]
    expect(result.subprocess.spawns[0]?.argv).toEqual(['sandbox', '--', process.execPath, launcherPath])
    expect(result.subprocess.spawns[0]?.env).not.toHaveProperty('DSH_COMMAND_CENTER_DISCORD_TOKEN')
    if (launcherPath === undefined) throw new Error('expected OpenClaw runtime launcher')
    const launcher = await readFile(launcherPath, 'utf8')
    expect(launcher).toContain('/resolved/openclaw')
    expect(launcher).toContain('/resolved/docker')
    expect(launcher).toContain(JSON.stringify(configPath))
    const privateState = join(snapshot(result, queued.id).root, 'workspace/.openclaw/sandbox-skills')
    await mkdir(privateState, { recursive: true })
    result.subprocess.handle.settle({ exitCode: 0, signal: null })
    await expect(settled(result, queued.id)).resolves.toMatchObject({ state: 'succeeded' })
    await expect(stat(privateState)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(launcherPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

})

describe.skipIf(process.platform !== 'linux')('OpenClaw confinement configuration', () => {
  it.each<{
    name: string
    allow: string[]
    binds: string[]
    agentRoster?: Record<string, unknown>
  }>([
    { name: 'extra tool', allow: ['group:fs', 'group:runtime', 'browser'], binds: [] },
    { name: 'extra bind mount', allow: ['group:fs', 'group:runtime'], binds: ['/unapproved:/unapproved:rw'] },
    {
      name: 'per-agent network override', allow: ['group:fs', 'group:runtime'], binds: [],
      agentRoster: { entries: { main: { sandbox: { docker: { network: 'bridge' } } } } },
    },
    {
      name: 'per-agent bind mount override', allow: ['group:fs', 'group:runtime'], binds: [],
      agentRoster: { entries: { main: { sandbox: { docker: { binds: ['/unapproved:/unapproved:rw'] } } } } },
    },
    {
      name: 'per-agent tool override', allow: ['group:fs', 'group:runtime'], binds: [],
      agentRoster: { entries: { main: { tools: { sandbox: { tools: { allow: ['browser'] } } } } } },
    },
    {
      name: 'legacy per-agent override', allow: ['group:fs', 'group:runtime'], binds: [],
      agentRoster: { list: [{ id: 'main', sandbox: { docker: { network: 'bridge' } } }] },
    },
  ])('rejects $name before spawning', async ({ allow, binds, agentRoster }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-openclaw-policy-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const configPath = join(root, 'openclaw.json')
    await writeFile(configPath, JSON.stringify({
      agents: {
        defaults: { sandbox: {
          mode: 'all', backend: 'docker', workspaceAccess: 'rw',
          docker: { network: 'none', user: HOST_DOCKER_USER, readOnlyRoot: true, capDrop: ['ALL'], binds },
        } },
        ...agentRoster,
      },
      tools: { elevated: { enabled: false }, sandbox: { tools: { allow } } },
    }))
    const result = await harness({ openclaw: { command: 'openclaw', configPath, dockerCommand: 'docker' } })
    cleanup.push(() => result.fiber.dispose())
    const queued = task('openclaw')
    result.tasks.set(queued.id, queued)
    await expect(result.ctx.taskExecution.run(queued.id)).resolves.toMatchObject({ state: 'failed' })
    expect(result.subprocess.spawns).toHaveLength(0)
  })
})

describe('safeTaskDetail', () => {
  it('redacts common secrets and truncates UTF-8 output without splitting a character', () => {
    expect(safeDetail('api_key: abcdEFGHijklMNOP and ghp_abcdefghijklmnop', 200)).toBe('secret:[redacted] and [redacted]')
    expect(safeDetail('opaque-value eyJabc.def.ghi', 200, ['opaque-value'])).toBe('[redacted] [redacted]')
    expect(safeDetail('short', 200, ['short'])).toBe('short')
    expect(safeDetail('/tmp/dsh-command-center-pi-example', 200)).toBe('/tmp/dsh-command-center-pi-example')
    expect(safeDetail('\u001B[36mstatus\u001B[39m', 200)).toBe('status')
    expect(safeDetail('ééé', 5)).toBe('\n[out')
    expect(safeDetail('ééé', 30)).toBe('ééé')
    expect(safeDetail('abcdefghijabcdefghija', 20)).toBe('a\n[output truncated]')
  })

  it('formats a signal outcome when neither output stream is collected', async () => {
    const result = await harness()
    cleanup.push(() => result.fiber.dispose())
    const queued = task('codex')
    result.tasks.set(queued.id, queued)
    const done: Promise<Outcome> = Promise.resolve({ exitCode: null, signal: 'SIGKILL' })
    const originalSpawn = (spec: SubprocessSpawnSpec) => result.ctx.subprocess.spawn(spec)
    result.ctx.subprocess.spawn = (spec) => {
      if (spec.argv.includes('auth')) return originalSpawn(spec)
      return {
        pid: 1,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        terminate: () => {},
        waitForExit: async () => true,
        done,
        collected: {},
      }
    }

    await result.ctx.taskExecution.run(queued.id)
    await expect(settled(result, queued.id)).resolves.toMatchObject({ state: 'failed', detail: 'signal: SIGKILL' })
  })

  it('retains only the requested byte count when even the truncation marker cannot fit', () => {
    expect(Buffer.byteLength(safeDetail('long output', 3))).toBe(3)
    expect(() => new TaskExecutionPolicyError('policy')).not.toThrow()
  })
})
