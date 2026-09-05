/**
 * Local solo-developer issue-to-pull-request execution with retained Git worktrees and versioned history.
 * @module @deepseek-ai/dsh-solo-factory
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'

/** Opaque identifier for one durable factory run. */
export type FactoryRunId = Branded<'FactoryRunId'>

/**
 * Brand an accepted or persisted factory run identifier.
 * @param value Raw identifier from trusted generation or validated history/tool input.
 * @returns The identifier with the factory-run brand.
 */
export function FactoryRunId(value: string): FactoryRunId { return value as FactoryRunId }

/** One external command; placeholders are expanded without a shell. */
export interface FactoryCommand { readonly executable: string; readonly args: readonly string[] }
/** Work item accepted by the solo factory. */
export interface FactoryIssue { readonly id: string; readonly title: string; readonly body: string }
/** One resumable stage in a factory run. */
export type FactoryStage = 'workspace' | 'implementation' | 'test' | 'review' | 'pull-request'
/** Durable transition emitted for one factory run. */
export interface FactoryEvent { readonly at: string; readonly state: FactoryState; readonly detail: string }
/** Result of one shell-free command attempt. */
export interface FactoryCommandResult {
  readonly stage: FactoryStage
  readonly command: FactoryCommand
  readonly startedAt: string
  readonly finishedAt: string
  readonly status: 'succeeded' | 'failed'
  readonly output?: string | undefined
  readonly error?: string | undefined
}
/** The terminally inspectable state of a factory run. */
export type FactoryState = 'accepted' | 'workspace-ready' | 'implemented' | 'tested' | 'reviewed' | 'pull-request-open' | 'failed'
/** Durable factory run record. */
export interface FactoryRun {
  readonly id: FactoryRunId
  readonly issue: FactoryIssue
  readonly branch: string
  readonly worktree: string
  readonly state: FactoryState
  readonly events: readonly FactoryEvent[]
  readonly commandResults: readonly FactoryCommandResult[]
  readonly failedStage?: FactoryStage | undefined
  readonly pullRequestUrl?: string | undefined
}

const factoryStageSchema = z.enum(['workspace', 'implementation', 'test', 'review', 'pull-request'])
const factoryStateSchema = z.enum(['accepted', 'workspace-ready', 'implemented', 'tested', 'reviewed', 'pull-request-open', 'failed'])
const factoryRunSchema = z.object({
  id: z.string().min(1).transform(FactoryRunId),
  issue: z.object({ id: z.string().min(1), title: z.string(), body: z.string() }),
  branch: z.string().min(1),
  worktree: z.string().min(1),
  state: factoryStateSchema,
  events: z.array(z.object({ at: z.string().min(1), state: factoryStateSchema, detail: z.string() })),
  commandResults: z.array(z.object({
    stage: factoryStageSchema,
    command: z.object({ executable: z.string().min(1), args: z.array(z.string()) }),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1),
    status: z.enum(['succeeded', 'failed']),
    output: z.string().optional(),
    error: z.string().optional(),
  })),
  failedStage: factoryStageSchema.optional(),
  pullRequestUrl: z.string().min(1).optional(),
})
const factoryHistorySchema = z.object({ formatVersion: z.literal(0), runs: z.array(factoryRunSchema) })

/** Commands and private storage paths for one repository's solo factory. */
export interface SoloFactoryConfig {
  /** Git checkout whose `origin/HEAD` starts each factory branch. */
  readonly repository: string
  /** Private parent directory for retained run worktrees. */
  readonly worktreeRoot: string
  /** Owner-only JSON file holding all run records for this repository. */
  readonly historyFile: string
  /** Git branch namespace prepended to generated branch names. */
  readonly branchPrefix: string
  /** Agent command that plans, implements, checks, commits, and pushes the issue branch. */
  readonly implement: FactoryCommand
  /** Repository-specific verification command. */
  readonly test: FactoryCommand
  /** Agent command that reviews the completed issue branch. */
  readonly review: FactoryCommand
  /** GitHub command that opens the reviewed pull request. */
  readonly pullRequest: FactoryCommand
}
/** Process adapter, replaceable by a test or a deployment-specific executor. */
export interface CommandRunner {
  /**
   * Execute one command and optionally return its standard output.
   * @param command Shell-free executable and arguments.
   * @param cwd Working directory for the child process.
   * @param captureOutput Whether to capture stdout instead of inheriting it.
   * @returns Captured stdout, or an empty string when output is inherited.
   */
  run(command: FactoryCommand, cwd: string, captureOutput?: boolean): Promise<string>
}

/** Execute commands without a shell. */
export class LocalCommandRunner implements CommandRunner {
  async run(command: FactoryCommand, cwd: string, captureOutput = false): Promise<string> {
    const { spawn } = await import('node:child_process')
    return await new Promise<string>((resolveRun, reject) => {
      const chunks: Buffer[] = []
      let outputBytes = 0
      let overflow = false
      const child = spawn(command.executable, command.args, {
        cwd,
        env: scrubbedParentEnv(),
        stdio: captureOutput ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      })
      if (captureOutput) (child.stdout as NonNullable<typeof child.stdout>).on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength
        if (outputBytes > 65_536) {
          overflow = true
          child.kill()
        } else {
          chunks.push(chunk)
        }
      })
      child.once('error', reject)
      child.once('close', (code) => {
        if (overflow) reject(new Error('captured output exceeds 65536 bytes'))
        else if (code === 0) resolveRun(Buffer.concat(chunks).toString('utf8'))
        else reject(new Error(`${command.executable} exited ${code ?? 'without a status'}`))
      })
    })
  }
}

function branchPart(value: string, field: 'id' | 'title', maxLength: number): string {
  const part = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (part === '') throw new Error(`issue ${field} must contain a letter or number`)
  return part.slice(0, maxLength)
}
function expand(command: FactoryCommand, run: FactoryRun): FactoryCommand {
  const values = {
    issue: run.issue.id,
    title: run.issue.title,
    body: run.issue.body,
    branch: run.branch,
    worktree: run.worktree,
  }
  const replace = (value: string) => value.replace(
    /\{(issue|title|body|branch|worktree)\}/g,
    (_, key: string) => values[key as keyof typeof values],
  )
  return { executable: replace(command.executable), args: command.args.map(replace) }
}

/* v8 ignore next -- FactoryStage is closed and every member is handled by the caller's switch. */
function assertNever(value: never): never {
  throw new Error(`unsupported factory stage: ${String(value)}`)
}

class RecordedCommandError extends Error {
  constructor(cause: unknown, readonly run: FactoryRun) {
    super('factory command failed', { cause })
  }
}

/** Error carrying the durable failed run needed to resume or inspect the work. */
export class FactoryRunError extends Error {
  /**
   * Describe one persisted factory failure.
   * @param run Failed run after its failure transition was written.
   * @param cause Original command or lifecycle failure.
   */
  constructor(readonly run: FactoryRun, cause: Error) {
    super(`factory run ${run.id} failed: ${cause.message}`, { cause })
  }
}

/** Creates isolated worktrees and records a complete local delivery history. */
export class SoloFactory {
  constructor(private readonly config: SoloFactoryConfig, private readonly commands: CommandRunner = new LocalCommandRunner()) {}

  private transition(run: FactoryRun, state: FactoryState, detail: string): FactoryRun {
    return { ...run, state, events: [...run.events, { at: new Date().toISOString(), state, detail }] }
  }

  private async prepareStorage(): Promise<void> {
    await Promise.all([
      mkdir(resolve(this.config.worktreeRoot), { recursive: true, mode: 0o700 }),
      mkdir(dirname(resolve(this.config.historyFile)), { recursive: true, mode: 0o700 }),
    ])
  }

  private async writeHistory(runs: readonly FactoryRun[]): Promise<void> {
    await writeFileAtomic(this.config.historyFile, `${JSON.stringify({ formatVersion: 0, runs })}\n`, { mode: 0o600, dirMode: 0o700 })
  }

  private async replace(run: FactoryRun): Promise<FactoryRun> {
    await this.prepareStorage()
    await withFileLock(this.config.historyFile, async () => {
      const prior = await this.history()
      await this.writeHistory([...prior.filter(candidate => candidate.id !== run.id), run])
    })
    return run
  }

  private async append(run: FactoryRun, state: FactoryState, detail: string): Promise<FactoryRun> {
    return await this.replace(this.transition(run, state, detail))
  }

  private async runCommand(
    run: FactoryRun,
    stage: FactoryStage,
    command: FactoryCommand,
    cwd: string,
    captureOutput = false,
  ): Promise<{ readonly run: FactoryRun; readonly output: string }> {
    const startedAt = new Date().toISOString()
    try {
      const output = await this.commands.run(command, cwd, captureOutput)
      const result: FactoryCommandResult = {
        stage, command, startedAt, finishedAt: new Date().toISOString(), status: 'succeeded',
        ...(output === '' ? {} : { output }),
      }
      return { run: await this.replace({ ...run, commandResults: [...run.commandResults, result] }), output }
    } catch (error) {
      const result: FactoryCommandResult = {
        stage, command, startedAt, finishedAt: new Date().toISOString(), status: 'failed',
        error: error instanceof Error ? error.message : 'factory command failed',
      }
      const failed = await this.replace({ ...run, commandResults: [...run.commandResults, result] })
      throw new RecordedCommandError(error, failed)
    }
  }

  private async accept(run: FactoryRun): Promise<FactoryRun> {
    const accepted = this.transition(run, 'accepted', 'issue accepted')
    await this.prepareStorage()
    await withFileLock(this.config.historyFile, async () => {
      const prior = await this.history()
      if (prior.some(candidate => candidate.issue.id === run.issue.id
        && candidate.state !== 'failed' && candidate.state !== 'pull-request-open')) {
        throw new Error(`issue ${run.issue.id} already has an active factory run`)
      }
      await this.writeHistory([...prior, accepted])
    })
    return accepted
  }
  /**
   * List durable runs, including failed handoffs.
   * @returns Validated runs in persisted order.
   */
  async history(): Promise<readonly FactoryRun[]> {
    let source: string
    try { source = await readFile(this.config.historyFile, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const history = factoryHistorySchema.parse(JSON.parse(source))
      const worktreeRoot = resolve(this.config.worktreeRoot)
      if (history.runs.some(run => resolve(run.worktree) !== join(worktreeRoot, basename(run.branch)))) throw new Error()
      return history.runs
    } catch {
      throw new Error(`unsupported solo factory history format in ${this.config.historyFile}`)
    }
  }
  private async findPullRequest(run: FactoryRun): Promise<{ readonly run: FactoryRun; readonly url?: string }> {
    const result = await this.runCommand(run, 'pull-request', {
      executable: 'gh',
      args: ['pr', 'list', '--head', run.branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""'],
    }, resolve(this.config.repository), true)
    const url = result.output.trim()
    return { run: result.run, ...(url === '' ? {} : { url }) }
  }

  private async continue(run: FactoryRun, start: FactoryStage): Promise<FactoryRun> {
    const stages: readonly FactoryStage[] = ['workspace', 'implementation', 'test', 'review', 'pull-request']
    let current = run
    let stage = start
    try {
      for (const candidate of stages.slice(stages.indexOf(start))) {
        stage = candidate
        switch (candidate) {
          case 'workspace': {
            const repository = resolve(this.config.repository)
            let result = await this.runCommand(current, candidate, { executable: 'git', args: ['fetch', 'origin'] }, repository)
            current = result.run
            result = await this.runCommand(current, candidate, { executable: 'git', args: ['worktree', 'add', '-b', current.branch, current.worktree, 'origin/HEAD'] }, repository)
            current = await this.append(result.run, 'workspace-ready', 'isolated worktree created')
            break
          }
          case 'implementation': {
            const result = await this.runCommand(current, candidate, expand(this.config.implement, current), current.worktree)
            current = await this.append(result.run, 'implemented', 'implementation command completed')
            break
          }
          case 'test': {
            const result = await this.runCommand(current, candidate, expand(this.config.test, current), current.worktree)
            current = await this.append(result.run, 'tested', 'test command completed')
            break
          }
          case 'review': {
            const result = await this.runCommand(current, candidate, expand(this.config.review, current), current.worktree)
            current = await this.append(result.run, 'reviewed', 'review command completed')
            break
          }
          case 'pull-request': {
            let lookup = await this.findPullRequest(current)
            current = lookup.run
            let pullRequestUrl = lookup.url
            if (pullRequestUrl === undefined) {
              const created = await this.runCommand(current, candidate, expand(this.config.pullRequest, current), current.worktree)
              lookup = await this.findPullRequest(created.run)
              current = lookup.run
              pullRequestUrl = lookup.url
            }
            if (pullRequestUrl === undefined) throw new Error(`pull request for ${current.branch} was not found after creation`)
            current = await this.append({ ...current, pullRequestUrl }, 'pull-request-open', 'pull request opened')
            break
          }
          /* v8 ignore next 2 -- candidate comes from the closed local FactoryStage list. */
          default:
            assertNever(candidate)
        }
      }
      return current
    } catch (error) {
      const cause = error instanceof RecordedCommandError ? error.cause : error
      const failure = cause instanceof Error ? cause : new Error('factory command failed', { cause })
      if (error instanceof RecordedCommandError) current = error.run
      const failed = await this.append({ ...current, failedStage: stage }, 'failed', failure.message)
      throw new FactoryRunError(failed, failure)
    }
  }

  /**
   * Execute one issue through implementation, review, and pull-request creation.
   * @param issue GitHub issue identity and requirements.
   * @returns The terminal run with its pull-request URL.
   * @throws {@link FactoryRunError} with the durable run when a stage records failure.
   */
  async execute(issue: FactoryIssue): Promise<FactoryRun> {
    const id = FactoryRunId(randomUUID())
    const branch = `${this.config.branchPrefix}/${branchPart(issue.id, 'id', 40)}-${branchPart(issue.title, 'title', 64)}-${id.slice(0, 8)}`
    const worktree = join(resolve(this.config.worktreeRoot), basename(branch))
    const run = await this.accept({ id, issue, branch, worktree, state: 'accepted', events: [], commandResults: [] })
    return await this.continue(run, 'workspace')
  }

  /**
   * Resume one failed run at its failed stage.
   * @param runId Durable id returned by an earlier failed run.
   * @returns The terminal run with its pull-request URL.
   * @throws {@link FactoryRunError} with the durable run when the resumed stage records failure.
   */
  async resume(runId: FactoryRunId): Promise<FactoryRun> {
    await this.prepareStorage()
    const reserved = await withFileLock(this.config.historyFile, async () => {
      const prior = await this.history()
      const failed = prior.find(run => run.id === runId)
      if (failed?.state !== 'failed' || failed.failedStage === undefined) throw new Error(`factory run ${runId} is not resumable`)
      const previous = [...failed.events].reverse().find(event => event.state !== 'failed')?.state ?? 'accepted'
      const { failedStage, ...retry } = failed
      const run = this.transition(retry, previous, `resuming ${failedStage}`)
      await this.writeHistory([...prior.filter(candidate => candidate.id !== runId), run])
      return { run, failedStage }
    })
    return await this.continue(reserved.run, reserved.failedStage)
  }
}
