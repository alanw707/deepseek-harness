/**
 * Approved sandboxed execution of command-center tasks.
 * @module @deepseek-ai/dsh-task-execution
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  applyTaskChangeSet,
  createTaskChangeSet,
  prepareTaskCopy,
  readTaskChangeSet,
  type TaskChangeSet,
  type TaskCopy,
  type TaskCopyLimits,
} from './task-copy.ts'
import { Context, Service } from '@deepseek-ai/cordis'
import JSON5 from 'json5'
import z from '@deepseek-ai/schemastery'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { Task, TaskId } from '@deepseek-ai/dsh-task-control'

export type { TaskChange, TaskChangeSet, TaskChangeSide } from './task-copy.ts'

/** Command prefix supplied by the local deployment. */
export interface CommandPrefix {
  /** Executable path or bare executable name resolved by `ctx.subprocess`. */
  readonly command: string
  /** Arguments preceding the executor-specific arguments. */
  readonly arguments?: string[]
}

/** Pi executor configuration. */
export interface PiExecutorConfig extends CommandPrefix {
  /** Pi catalog model selected through the user's stored subscription authentication. */
  readonly model: string
}

/** Codex executor configuration. */
export interface CodexExecutorConfig extends CommandPrefix {
  /** Existing Codex credential source copied without refresh authority into each ephemeral run. */
  readonly authPath: string
  /** Absolute static runtime directories needed by an installation outside minimal system paths. */
  readonly runtimeReadRoots?: string[]
}

/** OpenClaw executor configuration. */
export interface OpenClawExecutorConfig extends CommandPrefix {
  /** Dedicated OpenClaw JSON5 configuration with Docker task isolation. */
  readonly configPath: string
  /** Docker CLI used to remove the exact per-task sandbox container before settlement. */
  readonly dockerCommand: string
}

/** Deployment settings for the three fixed command-center executors. */
export interface Config {
  /** Pi noninteractive runner. */
  readonly pi: PiExecutorConfig
  /** Codex noninteractive runner. */
  readonly codex: CodexExecutorConfig
  /** OpenClaw isolated headless runner. */
  readonly openclaw: OpenClawExecutorConfig
  /** Private existing storage directory and limits for retained project snapshots. */
  readonly copies: Omit<TaskCopyLimits, 'excludedNames'> & {
    /** Existing owner-only directory outside all registered projects. */
    readonly directory: string
    /** Basenames excluded at every depth in addition to protected credential/configuration names. */
    readonly excludedNames: string[]
  }
  /** Whole-tree termination grace period. */
  readonly graceMs: number
  /** Maximum bytes retained from each executor output stream. */
  readonly outputLimitBytes: number
  /** Maximum combined before/after UTF-8 bytes available for exact dashboard review. */
  readonly reviewLimitBytes: number
}

type ResolvedCommandPrefix = Required<CommandPrefix>
type ResolvedPiExecutorConfig = Required<PiExecutorConfig>
type ResolvedCodexExecutorConfig = Required<CodexExecutorConfig>
type ResolvedOpenClawExecutorConfig = Required<OpenClawExecutorConfig>
type ResolvedConfig = Omit<Config, 'pi' | 'codex' | 'openclaw'> & {
  readonly pi: ResolvedPiExecutorConfig
  readonly codex: ResolvedCodexExecutorConfig
  readonly openclaw: ResolvedOpenClawExecutorConfig
}

interface LiveExecution {
  readonly handle: SubprocessHandle
  readonly prepared: PreparedExecution
  readonly copy: TaskCopy
  settled: Promise<Task>
  retryable: boolean
}

interface StartingExecution {
  readonly settled: Promise<void>
  readonly controller: AbortController
  handle?: SubprocessHandle
}

interface PreparedExecution {
  readonly argv: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly secrets: readonly string[]
  /** Existing private paths that the sandbox must expose without granting write access. */
  readonly readOnlyRoots: readonly string[]
  /** Release owned runtime resources; retries after partial cleanup must be safe. */
  dispose(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Starts and stops approved command-center task executors. */
    taskExecution: TaskExecution
  }
}

/** The requested executor does not meet the command center's enforced policy. */
export class TaskExecutionPolicyError extends Error {
  /** @param message - Enforced policy condition that prevents execution. */
  constructor(message: string) {
    super(message)
    this.name = 'TaskExecutionPolicyError'
  }
}

/**
 * Local task executor. It takes ownership only after a dashboard-approved
 * task reached `queued`, wraps every child in a full workspace-write sandbox,
 * and retains bounded redacted diagnostics in the durable task record.
 */
export class TaskExecution extends Service {
  static inject = ['sandbox', 'subprocess', 'taskControl', 'workspaceRegistry']
  static Config: z<Config> = z.object({
    pi: z.object({
      command: z.string().min(1),
      arguments: z.array(z.string()).default([]),
      model: z.string().min(1),
    }),
    codex: z.object({
      command: z.string().min(1),
      arguments: z.array(z.string()).default([]),
      authPath: z.string().min(1),
      runtimeReadRoots: z.array(z.string().min(1)).default([]),
    }),
    openclaw: z.object({
      command: z.string().min(1),
      arguments: z.array(z.string()).default([]),
      configPath: z.string().min(1),
      dockerCommand: z.string().min(1),
    }),
    copies: z.object({
      directory: z.string().min(1),
      maxEntries: z.number().min(1).step(1),
      maxBytes: z.number().min(1).step(1),
      excludedNames: z.array(z.string().min(1)),
    }),
    graceMs: z.number().min(1).step(1),
    outputLimitBytes: z.number().min(1).step(1),
    reviewLimitBytes: z.number().min(1).step(1),
  })

  private readonly config: ResolvedConfig
  private readonly live = new Map<TaskId, LiveExecution>()
  private readonly starting = new Map<TaskId, StartingExecution>()
  private applyTail: Promise<void> = Promise.resolve()
  private closing = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'taskExecution')
    this.config = config as ResolvedConfig
    if (!isAbsolute(this.config.copies.directory) || this.config.codex.runtimeReadRoots.some(path => !isAbsolute(path))) {
      throw new TaskExecutionPolicyError('task copy storage and Codex runtime read roots must be absolute paths')
    }
    ctx.effect(() => async () => {
      this.closing = true
      const ids = new Set([...this.starting.keys(), ...this.live.keys()])
      const outcomes = await Promise.allSettled([...ids].map(id => this.cancel(id)))
      await this.applyTail
      const failures: unknown[] = []
      /* v8 ignore next 2 -- Individual cancellation cleanup rejection is covered by explicit cancellation tests. */
      for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason)
      /* v8 ignore next -- See individual cancellation failure rationale above. */
      if (failures.length > 0) throw new AggregateError(failures, 'task executor cleanup incomplete')
    }, 'taskExecution.stopLiveTasks')
  }

  /**
   * Launch a queued, dashboard-approved task. The process runs only in its
   * private project copy and remains owned until a terminal record is durable.
   * The retained snapshot is bound to the task before any executor starts.
   * @param id - Task selected by the dashboard dispatcher.
   * @returns running task, or a failed task if pre-launch setup fails.
   */
  async run(id: TaskId): Promise<Task> {
    this.assertOpen()
    const queued = this.ctx.taskControl.get(id)
    if (queued === undefined) return await this.ctx.taskControl.start(id)
    if (queued.state !== 'queued') return await this.ctx.taskControl.start(id)

    const workspace = this.ctx.workspaceRegistry.get(queued.workspaceId)
    if (workspace === undefined || await workspace.status() !== 'ok') return await this.ctx.taskControl.start(id)
    this.assertOpen()
    const started = await this.ctx.taskControl.start(id)
    if (started.state !== 'running') return started

    let finishStarting!: () => void
    const starting: StartingExecution = {
      settled: new Promise<void>((resolve) => { finishStarting = resolve }),
      controller: new AbortController(),
    }
    this.starting.set(id, starting)
    let prepared: PreparedExecution | undefined
    let copy: TaskCopy | undefined
    let copyRecorded = false
    try {
      this.assertOpen()
      await this.ctx.taskControl.consumeApproval(id)
      copy = await prepareTaskCopy(workspace.path, this.config.copies.directory, this.config.copies, starting.controller.signal)
      const approved = await this.ctx.taskControl.recordCopy(id, {
        root: copy.root, original: copy.original, manifestSha256: copy.manifestSha256,
      })
      copyRecorded = true
      prepared = await this.prepare(approved, copy, starting)
      const confined = this.ctx.sandbox.confine(prepared.argv, workspacePolicy(copy.workspace, prepared.readOnlyRoots))
      if (confined.enforcement !== 'full') {
        throw new TaskExecutionPolicyError('task executor requires a full workspace-write sandbox')
      }
      const current = this.ctx.taskControl.get(id)
      if (current?.state !== 'running') {
        return current?.state === 'cancelling'
          ? await this.ctx.taskControl.settle(id, 'cancelled', 'cancelled before executor process start')
          : current ?? started
      }
      const handle = this.ctx.subprocess.spawn({
        argv: confined.argv,
        cwd: copy.workspace,
        env: prepared.env,
        graceMs: this.config.graceMs,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.config.outputLimitBytes },
          stderr: { maxBytes: this.config.outputLimitBytes },
        },
      })
      const live: LiveExecution = {
        handle,
        prepared,
        copy,
        settled: this.settleProcess(approved, handle, prepared, copy),
        retryable: false,
      }
      this.live.set(id, live)
      void live.settled.catch(() => { live.retryable = true })
      prepared = undefined
      return approved
    } catch (error) {
      const current = this.ctx.taskControl.get(id)
      const detail = safeDetail(error instanceof Error ? error.message : String(error), this.config.outputLimitBytes)
      if (current === undefined) return started
      if (current.state === 'cancelling') return await this.ctx.taskControl.settle(id, 'cancelled', detail)
      if (current.state !== 'running') return current
      return await this.ctx.taskControl.settle(id, 'failed', detail)
    } finally {
      try {
        await prepared?.dispose()
        if (copy !== undefined && !copyRecorded) await rm(copy.root, { recursive: true, force: true })
      } finally {
        this.starting.delete(id)
        finishStarting()
      }
    }
  }

  /**
   * Cancel a queued task or terminate a running executor tree and wait for the
   * durable cancelled result. Returning means no owned child process remains.
   * @param id - Task to stop.
   * @returns durable terminal task.
   */
  async cancel(id: TaskId): Promise<Task> {
    const task = await this.ctx.taskControl.cancel(id)
    if (task.state !== 'cancelling') return task
    const starting = this.starting.get(id)
    if (starting !== undefined) {
      starting.controller.abort()
      starting.handle?.terminate()
      if (starting.handle !== undefined) await starting.handle.waitForExit()
      await starting.settled
    }
    const live = this.live.get(id)
    if (live === undefined) {
      const current = this.ctx.taskControl.get(id)
      return current?.state === 'cancelling'
        ? await this.ctx.taskControl.settle(id, 'cancelled', 'cancelled before executor process start')
        : current ?? task
    }
    live.handle.terminate()
    if (live.retryable) {
      live.retryable = false
      live.settled = this.settleProcess(task, live.handle, live.prepared, live.copy)
      void live.settled.catch(() => { live.retryable = true })
    }
    return await live.settled
  }

  /**
   * Read the exact digest-bound changes produced by a successful task.
   * @param id - Settled task selected in the dashboard.
   * @returns Verified complete UTF-8 before/after review data; an empty set represents `no-change`.
   */
  async review(id: TaskId): Promise<TaskChangeSet> {
    const task = this.ctx.taskControl.get(id)
    if (task?.state !== 'succeeded' || task.copy?.changes === undefined) {
      throw new TaskExecutionPolicyError(`task '${id}' has no successful staged changes to review`)
    }
    return await readTaskChangeSet(task.copy, this.config.copies.directory, this.config.reviewLimitBytes)
  }

  /**
   * Consume dashboard approval for one non-empty exact change-set digest and apply it once.
   * A `no-change` outcome cannot enter apply. Conflicting original files reject
   * without replacing user work. Apply attempts are globally serialized because
   * registered project directories may overlap.
   * @param id - Successful task whose staged changes were displayed.
   * @param sha256 - Exact displayed change-set digest.
   * @returns Task carrying the terminal apply state.
   */
  apply(id: TaskId, sha256: string): Promise<Task> {
    const result = this.applyTail.then(async () => {
      this.assertOpen()
      const task = this.ctx.taskControl.get(id)
      const workspace = task === undefined ? undefined : this.ctx.workspaceRegistry.get(task.workspaceId)
      if (task?.copy === undefined || workspace === undefined || workspace.path !== task.copy.original || await workspace.status() !== 'ok') {
        throw new TaskExecutionPolicyError('registered project is unavailable or no longer matches the staged task')
      }
      const applying = await this.ctx.taskControl.beginApply(id, sha256)
      if (applying.copy === undefined) throw new TaskExecutionPolicyError('applying task lost its durable project copy')
      try {
        const detail = await applyTaskChangeSet(applying.copy, this.config.copies.directory, this.config.reviewLimitBytes)
        return await this.ctx.taskControl.finishApply(id, 'applied', detail)
      } catch (error) {
        /* v8 ignore next -- Filesystem and retained-manifest operations reject with Error instances. */
        const detail = safeDetail(error instanceof Error ? error.message : String(error), this.config.outputLimitBytes)
        return await this.ctx.taskControl.finishApply(id, 'apply-failed', detail)
      }
    })
    this.applyTail = result.then(() => {}, () => {})
    return result
  }

  private assertOpen(): void {
    if (this.closing) throw new TaskExecutionPolicyError('task executor is stopping')
  }

  private async prepare(task: Task, copy: TaskCopy, starting: StartingExecution): Promise<PreparedExecution> {
    switch (task.executor) {
      case 'pi':
        return await this.preparePi(task, copy, starting)
      case 'codex':
        return await this.prepareCodex(task, copy)
      case 'openclaw':
        return await this.prepareOpenClaw(task, copy)
      /* v8 ignore next -- TaskExecutor is closed by the durable task schema. */
      default:
        return assertNever(task.executor)
    }
  }

  private async prepareOpenClaw(task: Task, copy: TaskCopy): Promise<PreparedExecution> {
    await validateOpenClawConfig(this.config.openclaw.configPath)
    const staging = await mkdtemp(join(copy.root, '.dsh-command-center-openclaw-'))
    try {
      const [openclaw, docker] = await Promise.all([
        this.resolve(this.config.openclaw, [
          'agent', 'exec', '--json', '--cwd', copy.workspace, '--config', this.config.openclaw.configPath, task.instruction,
        ]),
        this.ctx.subprocess.resolveExecutable(this.config.openclaw.dockerCommand),
      ])
      const launcherPath = join(staging, 'runtime.mjs')
      await writeFile(launcherPath, openClawLauncherSource(openclaw, docker, copy.workspace), { mode: 0o600 })
      return {
        argv: [process.execPath, launcherPath],
        env: openClawEnvironment(),
        secrets: [],
        readOnlyRoots: [staging],
        dispose: async () => { await removeRuntimePaths([join(copy.workspace, '.openclaw'), staging]) },
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  private async preparePi(task: Task, copy: TaskCopy, starting: StartingExecution): Promise<PreparedExecution> {
    const { bearer, command } = await this.openAiCodexBearer(task, copy.workspace, starting)
    const staging = await mkdtemp(join(copy.root, '.dsh-command-center-pi-'))
    const runtime = await mkdtemp('/tmp/dsh-command-center-pi-')
    try {
      const launcherPath = join(staging, 'runtime.mjs')
      const guardPath = join(staging, 'workspace-guard.mjs')
      await writeFile(launcherPath, RUNTIME_LAUNCHER, { mode: 0o500 })
      await writeFile(guardPath, PI_WORKSPACE_GUARD, { mode: 0o400 })
      return {
        argv: [
          process.execPath, launcherPath, 'pi', runtime, '-', command, ...this.config.pi.arguments,
          '--no-session', '--no-context-files', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes',
          '--extension', guardPath,
          '--model', this.config.pi.model,
          '--tools', 'read,write,edit,grep,find,ls',
          '--print', task.instruction,
        ],
        env: { ...piEnvironment(), PI_CODING_AGENT_DIR: runtime, DSH_COMMAND_CENTER_PI_BEARER: bearer },
        secrets: [bearer],
        readOnlyRoots: [staging],
        dispose: async () => { await removeRuntimePaths([staging, runtime]) },
      }
    /* v8 ignore next 4 -- Requires host failure while writing newly created private staging files. */
    } catch (error) {
      /* v8 ignore next -- See private staging host-failure rationale above. */
      await removeRuntimePaths([staging, runtime])
      /* v8 ignore next -- See private staging host-failure rationale above. */
      throw error
    }
  }

  private async prepareCodex(task: Task, copy: TaskCopy): Promise<PreparedExecution> {
    const command = await this.ctx.subprocess.resolveExecutable(this.config.codex.command)
    if (this.ctx.taskControl.get(task.id)?.state !== 'running') throw new Error('cancelled before Codex authentication')
    const staging = await mkdtemp(join(copy.root, '.dsh-command-center-codex-'))
    const runtime = await mkdtemp('/tmp/dsh-command-center-codex-')
    try {
      const authPath = join(staging, 'auth.json')
      const launcherPath = join(staging, 'runtime.mjs')
      const secrets = await stageCodexAuth(this.config.codex.authPath, authPath)
      await writeFile(launcherPath, RUNTIME_LAUNCHER, { mode: 0o500 })
      /* v8 ignore next -- Cancellation races are covered before and during executable resolution. */
      if (this.ctx.taskControl.get(task.id)?.state !== 'running') throw new Error('cancelled after Codex authentication')
      return {
        argv: [
          process.execPath, launcherPath, 'codex', runtime, authPath, command, ...this.config.codex.arguments,
          'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config', '--skip-git-repo-check',
          '-c', 'approval_policy="never"',
          '-c', 'default_permissions="command-center"',
          '-c', `permissions.command-center.filesystem={${[
            '":minimal"="read"',
            ...this.config.codex.runtimeReadRoots.map(path => `${JSON.stringify(path)}="read"`),
            `${JSON.stringify(copy.root)}="deny"`,
            `${JSON.stringify(copy.original)}="deny"`,
            `${JSON.stringify(runtime)}="deny"`,
            '":workspace_roots"={"."="write"}',
          ].join(',')}}`,
          '-c', 'permissions.command-center.network.enabled=false',
          '-C', copy.workspace, task.instruction,
        ],
        env: { CODEX_HOME: runtime },
        secrets,
        readOnlyRoots: [staging],
        dispose: async () => { await removeRuntimePaths([staging, runtime]) },
      }
    } catch (error) {
      await removeRuntimePaths([staging, runtime])
      throw error
    }
  }

  private async openAiCodexBearer(
    task: Task,
    workspacePath: string,
    starting: StartingExecution,
  ): Promise<{ readonly bearer: string; readonly command: string }> {
    const command = await this.ctx.subprocess.resolveExecutable(this.config.pi.command)
    if (this.ctx.taskControl.get(task.id)?.state !== 'running') throw new Error('cancelled before OpenAI Codex authentication')
    const auth = this.ctx.subprocess.spawn({
      argv: [command, ...this.config.pi.arguments, 'auth', 'check', '--provider', 'openai-codex', '--no-refresh', '--credentials', '--json'],
      cwd: workspacePath,
      graceMs: this.config.graceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.outputLimitBytes },
        stderr: { maxBytes: this.config.outputLimitBytes },
      },
      env: piEnvironment(),
    })
    starting.handle = auth
    const outcome = await auth.done.finally(() => {
      delete starting.handle
    })
    if (outcome.exitCode !== 0) {
      throw new TaskExecutionPolicyError('OpenAI Codex cached authentication unavailable; authenticate outside the task before retrying')
    }
    let credential: unknown
    try {
      credential = JSON.parse(auth.collected.stdout?.readFrom(0).text ?? '')
    } catch {
      // Malformed helper JSON may contain credentials; do not include parser diagnostics.
      throw new TaskExecutionPolicyError('OpenAI Codex authentication returned invalid credential metadata')
    }
    if (typeof credential !== 'object' || credential === null
      || !('status' in credential) || credential.status !== 'ready'
      || !('provider' in credential) || credential.provider !== 'openai-codex'
      || !('credentials' in credential) || typeof credential.credentials !== 'string'
      || credential.credentials === '' || /\s/u.test(credential.credentials)) {
      throw new TaskExecutionPolicyError('OpenAI Codex authentication returned invalid credential metadata')
    }
    const bearer = credential.credentials
    if (this.ctx.taskControl.get(task.id)?.state !== 'running') throw new Error('cancelled after OpenAI Codex authentication')
    return { bearer, command }
  }

  private async resolve(prefix: ResolvedCommandPrefix, arguments_: readonly string[]): Promise<readonly [string, ...string[]]> {
    const command = await this.ctx.subprocess.resolveExecutable(prefix.command)
    return [command, ...prefix.arguments, ...arguments_]
  }

  private async settleProcess(task: Task, handle: SubprocessHandle, prepared: PreparedExecution, copy: TaskCopy): Promise<Task> {
    let state: 'succeeded' | 'failed' = 'failed'
    let detail: string
    try {
      const outcome = await handle.done
      state = outcome.exitCode === 0 ? 'succeeded' : 'failed'
      detail = outputDetail(handle, outcome.exitCode, outcome.signal, this.config.outputLimitBytes, prepared.secrets)
    } catch (error) {
      detail = safeDetail(String(error), this.config.outputLimitBytes, prepared.secrets)
    }
    try {
      if (!await handle.waitForExit()) throw new Error('executor process tree has not stopped')
      await prepared.dispose()
    } catch (error) {
      const failure = safeDetail(`executor cleanup failed: ${String(error)}`, this.config.outputLimitBytes, prepared.secrets)
      await this.ctx.taskControl.recordExecutionError(task.id, failure)
      throw new TaskExecutionPolicyError(failure)
    }
    let current = this.ctx.taskControl.get(task.id)
    if (current?.state === 'running' && state === 'succeeded') {
      try {
        const changes = await createTaskChangeSet(copy, this.config.reviewLimitBytes)
        current = await this.ctx.taskControl.recordChanges(task.id, { sha256: changes.sha256, count: changes.changes.length })
      } catch (error) {
        state = 'failed'
        /* v8 ignore next -- Change derivation rejects with Error instances. */
        detail = safeDetail(`${detail}\nchange review failed: ${error instanceof Error ? error.message : String(error)}`, this.config.outputLimitBytes, prepared.secrets)
      }
    }
    const result = current?.state === 'cancelling'
      ? await this.ctx.taskControl.settle(task.id, 'cancelled', detail)
      : current?.state === 'running'
        ? await this.ctx.taskControl.settle(task.id, state, detail)
        : current ?? task
    this.live.delete(task.id)
    return result
  }
}

function workspacePolicy(workspaceRoot: string, readOnlyRoots: readonly string[]): SandboxPolicy {
  return { mode: 'workspace-write', workspaceRoot, readOnlyRoots }
}

function piEnvironment(): NodeJS.ProcessEnv {
  return { PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }
}

function openClawEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TZ']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

async function removeRuntimePaths(paths: readonly string[]): Promise<void> {
  const outcomes = await Promise.allSettled(paths.map(path => rm(path, { recursive: true, force: true })))
  const failures: unknown[] = []
  for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason as unknown)
  if (failures.length > 0) throw new AggregateError(failures, 'executor private runtime cleanup failed')
}

function openClawLauncherSource(openclaw: readonly [string, ...string[]], docker: string, workspace: string): string {
  const [command] = openclaw
  return `
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'

const command = ${JSON.stringify(command)}
const argv = ${JSON.stringify(openclaw.slice(1))}
const docker = ${JSON.stringify(docker)}
const workspace = ${JSON.stringify(workspace)}
const child = spawn(command, argv, { env: process.env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.kill(signal) })
const status = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => { resolve({ code, signal }) })
})
let cleanupFailed = false
chmodSync(workspace, 0o755)
try {
  const ids = execFileSync(docker, ['container', 'ls', '--all', '--quiet', '--filter', 'label=openclaw.sandbox=1'], { maxBuffer: 1024 * 1024 })
    .toString('utf8').trim().split(/\\s+/u).filter(Boolean)
  for (const id of ids) {
    const mounts = JSON.parse(execFileSync(docker, ['container', 'inspect', '--format', '{{json .Mounts}}', id], { maxBuffer: 1024 * 1024 }).toString('utf8'))
    if (Array.isArray(mounts) && mounts.some(mount => mount && mount.Source === workspace)) {
      spawnSync(docker, ['container', 'exec', '--user', '0:0', id, 'chmod', '0777', '/workspace/.openclaw', '/workspace/.openclaw/sandbox-skills'], { stdio: 'ignore' })
      execFileSync(docker, ['container', 'rm', '--force', id], { maxBuffer: 1024 * 1024 })
    }
  }
} catch {
  cleanupFailed = true
} finally {
  chmodSync(workspace, 0o700)
}
if (cleanupFailed) {
  console.error('OpenClaw task sandbox container cleanup failed')
  process.exit(1)
}
if (status.signal !== null) process.kill(process.pid, status.signal)
process.exit(status.code ?? 1)
`
}

const RUNTIME_LAUNCHER = `
import { spawn } from 'node:child_process'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'

const [kind, runtime, source, command, ...argv] = process.argv.slice(2)
if ((kind !== 'pi' && kind !== 'codex') || !runtime || !command) throw new Error('invalid private runtime launch')
await mkdir(runtime, { recursive: true, mode: 0o700 })
if (kind === 'pi') {
  await writeFile(new URL('models.json', 'file://' + runtime + '/'), JSON.stringify({
    providers: { 'openai-codex': { apiKey: '$DSH_COMMAND_CENTER_PI_BEARER' } },
  }), { mode: 0o600 })
  process.env.PI_CODING_AGENT_DIR = runtime
} else {
  await copyFile(source, new URL('auth.json', 'file://' + runtime + '/'))
  process.env.CODEX_HOME = runtime
}
const child = spawn(command, argv, { env: process.env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { child.kill(signal) })
const status = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => { resolve({ code, signal }) })
})
if (status.signal !== null) process.kill(process.pid, status.signal)
process.exit(status.code ?? 1)
`

const PI_WORKSPACE_GUARD = `
import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const guarded = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])

async function nearestExisting(path) {
  let current = path
  while (true) {
    try {
      return await realpath(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) throw new Error('path has no existing ancestor')
      current = parent
    }
  }
}

function contains(root, path) {
  const fromRoot = relative(root, path)
  return fromRoot === '' || !(fromRoot === '..' || fromRoot.startsWith('..' + sep) || isAbsolute(fromRoot))
}

export default function workspaceGuard(pi) {
  const rootPromise = realpath(process.cwd())
  const privateRootPromise = realpath(process.env.PI_CODING_AGENT_DIR)
  pi.on('tool_call', async event => {
    if (!guarded.has(event.toolName)) return
    const root = await rootPromise
    const raw = event.input && typeof event.input.path === 'string' ? event.input.path.replace(/^@/u, '') : '.'
    const candidate = resolve(root, raw)
    let actual
    try {
      actual = await realpath(candidate)
    } catch {
      if (event.toolName !== 'write') return { block: true, reason: 'Path cannot be resolved inside the approved project.' }
      actual = await nearestExisting(dirname(candidate))
    }
    if (!contains(root, actual)) return { block: true, reason: 'Only files inside the approved project are available.' }
    if (contains(await privateRootPromise, actual)) return { block: true, reason: 'Command-center private files are unavailable.' }
  })
}
`

function outputDetail(
  handle: SubprocessHandle,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  maxBytes: number,
  secrets: readonly string[],
): string {
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  const status = signal === null ? `exit code: ${exitCode}` : `signal: ${signal}`
  return safeDetail(
    [status, stdout === '' ? '' : `stdout:\n${stdout}`, stderr === '' ? '' : `stderr:\n${stderr}`].filter(Boolean).join('\n'),
    maxBytes,
    secrets,
  )
}

/**
 * Remove known and common credential forms before durable output storage.
 * @param value - Captured process output or failure text.
 * @param maxBytes - Maximum UTF-8 bytes retained.
 * @param secrets - Exact credential values to remove.
 * @returns Bounded, redacted plain text.
 */
export function safeDetail(value: string, maxBytes: number, secrets: readonly string[] = []): string {
  const plain = value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  const exact = secrets.reduce((text, secret) => secret.length < 8 ? text : text.split(secret).join('[redacted]'), plain)
  const redacted = exact
    .replace(/\b(?:api[_-]?key|token|password|secret)\b\s*([=:])\s*[^\s"']+/giu, (_match, separator: string) => `secret${separator}[redacted]`)
    .replace(/\bBearer\s+[a-z0-9._~+\-/]+=*/giu, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted]')
    .replace(/\b(?:(?:sk|ds)-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9_-]{12,}|xox[baprs]-[a-z0-9_-]{12,})\b/giu, '[redacted]')
  return truncateUtf8(redacted, maxBytes)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const marker = '\n[output truncated]'
  const markerBytes = Buffer.byteLength(marker)
  if (maxBytes <= markerBytes) return Buffer.from(marker).subarray(0, maxBytes).toString('utf8')
  let end = value.length
  while (Buffer.byteLength(value.slice(0, end)) > maxBytes - markerBytes) end -= 1
  return `${value.slice(0, end)}${marker}`
}

async function stageCodexAuth(sourcePath: string, destinationPath: string): Promise<readonly string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(sourcePath, 'utf8')) as unknown
  } catch {
    throw new TaskExecutionPolicyError('configured Codex credential file cannot be read')
  }
  const root = object(parsed)
  if (typeof root.auth_mode !== 'string') throw new TaskExecutionPolicyError('configured Codex credential file is invalid')
  if (typeof root.OPENAI_API_KEY === 'string' && root.OPENAI_API_KEY !== '') {
    await writeFile(destinationPath, JSON.stringify(root), { mode: 0o600 })
    return [root.OPENAI_API_KEY]
  }
  const tokens = object(root.tokens)
  const idToken = tokens.id_token
  const accessToken = tokens.access_token
  const accountId = tokens.account_id
  if (typeof idToken !== 'string' || typeof accessToken !== 'string' || typeof accountId !== 'string') {
    throw new TaskExecutionPolicyError('configured Codex credential file is invalid')
  }
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined
  await writeFile(destinationPath, JSON.stringify({
    ...root,
    tokens: { ...tokens, refresh_token: '' },
  }), { mode: 0o600 })
  return [idToken, accessToken, ...(refreshToken === undefined ? [] : [refreshToken])]
}

async function validateOpenClawConfig(path: string): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON5.parse(await readFile(path, 'utf8'))
  } catch {
    throw new TaskExecutionPolicyError('OpenClaw task configuration cannot be parsed')
  }
  const root = object(parsed)
  const agents = object(root.agents)
  const sandbox = object(object(agents.defaults).sandbox)
  const docker = object(sandbox.docker)
  const tools = object(root.tools)
  const sandboxTools = object(object(tools.sandbox).tools)
  const allowed = stringArray(sandboxTools.allow)
  const hostDockerUser = currentDockerUser()
  const unsafe = [
    agents.entries !== undefined || agents.list !== undefined,
    sandbox.mode !== 'all',
    sandbox.backend !== 'docker',
    sandbox.workspaceAccess !== 'rw',
    docker.network !== 'none',
    docker.user !== hostDockerUser,
    docker.readOnlyRoot !== true,
    !stringArray(docker.capDrop).includes('ALL'),
    object(tools.elevated).enabled !== false,
    !allowed.includes('group:fs'),
    !allowed.includes('group:runtime'),
    allowed.length !== 2,
    docker.binds !== undefined && (!Array.isArray(docker.binds) || docker.binds.length !== 0),
  ]
  if (unsafe.some(Boolean)) {
    throw new TaskExecutionPolicyError('OpenClaw task configuration must enforce Docker workspace isolation, omit per-agent overrides, match host user ownership, use no extra bind mounts, network, or elevation, and expose only filesystem/runtime sandbox tools')
  }
}

function currentDockerUser(): string {
  const { getuid, getgid } = process
  /* v8 ignore next 2 -- Linux-only snapshot preparation rejects before OpenClaw validation elsewhere. */
  if (getuid === undefined || getgid === undefined) throw new TaskExecutionPolicyError('OpenClaw task execution requires Linux user identifiers')
  return `${String(getuid())}:${String(getgid())}`
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []
}

/* v8 ignore next -- TaskExecutor is closed by the durable task schema. */
function assertNever(value: never): never {
  throw new Error(`unsupported task executor '${String(value)}'`)
}

export default TaskExecution
