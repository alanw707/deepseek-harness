import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { FactoryRunError, FactoryRunId, LocalCommandRunner, SoloFactory, type CommandRunner, type FactoryCommand, type SoloFactoryConfig } from '../src/index.ts'
import * as SoloFactoryInvariant from '../src/invariant.ts'

const exec = promisify(execFile)
async function git(cwd: string, ...args: string[]): Promise<void> { await exec('git', args, { cwd }) }

async function repository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'dsh-factory-repo-'))
  await git(path, 'init', '--initial-branch=main')
  await git(path, 'config', 'user.email', 'factory@example.test')
  await git(path, 'config', 'user.name', 'Factory')
  await writeFile(join(path, 'README.md'), 'factory\n')
  await git(path, 'add', 'README.md')
  await git(path, 'commit', '-m', 'initial')
  await git(path, 'remote', 'add', 'origin', path)
  await git(path, 'fetch', 'origin')
  await git(path, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  return path
}

class RecordingRunner implements CommandRunner {
  readonly calls: { command: FactoryCommand; cwd: string; captureOutput: boolean }[] = []
  private prExists = false
  private failed = false

  constructor(private readonly failOnce?: string) {}

  async run(command: FactoryCommand, cwd: string, captureOutput = false): Promise<string> {
    this.calls.push({ command, cwd, captureOutput })
    if (command.executable === this.failOnce && !this.failed) {
      this.failed = true
      throw new Error(`${command.executable} failed`)
    }
    if (command.executable === 'git') {
      await exec(command.executable, command.args, { cwd })
      return ''
    }
    if (command.executable === 'gh') return this.prExists ? 'https://github.com/acme/widget/pull/7\n' : ''
    if (command.executable === 'open-pr') this.prExists = true
    return ''
  }
}

class PullRequestRecoveryRunner implements CommandRunner {
  readonly calls: string[] = []
  private lookups = 0

  async run(command: FactoryCommand, cwd: string): Promise<string> {
    this.calls.push(command.executable)
    if (command.executable === 'git') {
      await exec(command.executable, command.args, { cwd })
      return ''
    }
    if (command.executable === 'gh') {
      this.lookups += 1
      if (this.lookups === 1) return ''
      if (this.lookups === 2) throw new Error('lookup interrupted')
      return 'https://github.com/acme/widget/pull/9\n'
    }
    return ''
  }
}

class ExistingPullRequestRunner extends RecordingRunner {
  override async run(command: FactoryCommand, cwd: string, captureOutput = false): Promise<string> {
    if (command.executable === 'open-pr') throw new Error('duplicate pull request')
    if (command.executable === 'gh') {
      this.calls.push({ command, cwd, captureOutput })
      return 'https://github.com/acme/widget/pull/8\n'
    }
    return await super.run(command, cwd, captureOutput)
  }
}

class MissingPullRequestRunner extends RecordingRunner {
  override async run(command: FactoryCommand, cwd: string, captureOutput = false): Promise<string> {
    if (command.executable === 'gh' || command.executable === 'open-pr') {
      this.calls.push({ command, cwd, captureOutput })
      return ''
    }
    return await super.run(command, cwd, captureOutput)
  }
}

class NonErrorFailureRunner extends RecordingRunner {
  override async run(command: FactoryCommand, cwd: string, captureOutput = false): Promise<string> {
    if (command.executable === 'test') {
      this.calls.push({ command, cwd, captureOutput })
      return await Promise.reject.bind(Promise)('string failure')
    }
    return await super.run(command, cwd, captureOutput)
  }
}

class BlockingRunner extends RecordingRunner {
  private enter!: () => void
  private release!: () => void
  readonly entered = new Promise<void>((resolve) => { this.enter = resolve })
  readonly blocked = new Promise<void>((resolve) => { this.release = resolve })

  unblock(): void { this.release() }

  override async run(command: FactoryCommand, cwd: string, captureOutput = false): Promise<string> {
    if (command.executable === 'implement') {
      this.enter()
      await this.blocked
    }
    return await super.run(command, cwd, captureOutput)
  }
}

const command = (name: string): FactoryCommand => ({ executable: name, args: [] })
function config(repo: string): SoloFactoryConfig {
  return {
    repository: repo,
    worktreeRoot: join(repo, '.factory'),
    historyFile: join(repo, '.factory', 'runs.json'),
    branchPrefix: 'factory',
    implement: command('implement'),
    test: command('test'),
    review: command('review'),
    pullRequest: command('open-pr'),
  }
}

describe('SoloFactory', () => {
  it('runs local commands without a shell and reports launch and exit failures', async () => {
    const repo = await repository()
    const runner = new LocalCommandRunner()

    await expect(runner.run({ executable: process.execPath, args: ['--eval', ''] }, repo)).resolves.toBe('')
    await expect(runner.run({ executable: process.execPath, args: ['--eval', 'process.exit(3)'] }, repo))
      .rejects.toThrow('exited 3')
    await expect(runner.run({ executable: process.execPath, args: ['--eval', "process.kill(process.pid, 'SIGTERM')"] }, repo))
      .rejects.toThrow('without a status')
    await expect(runner.run({ executable: join(repo, 'missing-command'), args: [] }, repo))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('bounds captured command output by encoded bytes', async () => {
    const repo = await repository()
    const runner = new LocalCommandRunner()
    await expect(runner.run({
      executable: process.execPath,
      args: ['--eval', "process.stdout.write('x'.repeat(65_536))"],
    }, repo, true)).resolves.toHaveLength(65_536)
    await expect(runner.run({
      executable: process.execPath,
      args: ['--eval', "process.stdout.write('x'.repeat(65_537))"],
    }, repo, true)).rejects.toThrow('captured output exceeds 65536 bytes')
    await expect(runner.run({
      executable: process.execPath,
      args: ['--eval', "process.stdout.write('🙂'.repeat(16_385))"],
    }, repo, true)).rejects.toThrow('captured output exceeds 65536 bytes')
  })

  it('creates an isolated worktree and stops after opening a pull request', async () => {
    const repo = await repository()
    const runner = new RecordingRunner()
    const factoryConfig = {
      ...config(repo),
      implement: { executable: 'implement', args: ['{issue}', '{title}', '{body}', '{branch}', '{worktree}'] },
    }
    const factory = new SoloFactory(factoryConfig, runner)

    const run = await factory.execute({ id: '42', title: 'Add factory', body: 'Build it' })

    expect(run).toMatchObject({
      state: 'pull-request-open',
      pullRequestUrl: 'https://github.com/acme/widget/pull/7',
    })
    expect(run.events.map(event => event.state)).toEqual([
      'accepted', 'workspace-ready', 'implemented', 'tested', 'reviewed', 'pull-request-open',
    ])
    expect(run.commandResults.map(result => [result.stage, result.command.executable, result.status])).toEqual([
      ['workspace', 'git', 'succeeded'],
      ['workspace', 'git', 'succeeded'],
      ['implementation', 'implement', 'succeeded'],
      ['test', 'test', 'succeeded'],
      ['review', 'review', 'succeeded'],
      ['pull-request', 'gh', 'succeeded'],
      ['pull-request', 'open-pr', 'succeeded'],
      ['pull-request', 'gh', 'succeeded'],
    ])
    expect(runner.calls.map(call => call.command.executable)).toEqual([
      'git', 'git', 'implement', 'test', 'review', 'gh', 'open-pr', 'gh',
    ])
    expect(runner.calls.find(call => call.command.executable === 'implement')?.command.args)
      .toEqual(['42', 'Add factory', 'Build it', run.branch, run.worktree])
    await expect(stat(run.worktree)).resolves.toMatchObject({})
    expect((await stat(config(repo).historyFile)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(config(repo).historyFile, 'utf8'))).toMatchObject({ formatVersion: 0 })
    expect(await factory.history()).toEqual([run])
  })

  it('rejects issue fields that cannot form Git branch components', async () => {
    const repo = await repository()
    const factory = new SoloFactory(config(repo), new RecordingRunner())
    await expect(factory.execute({ id: '!!!', title: 'Invalid id', body: '' }))
      .rejects.toThrow('issue id must contain a letter or number')
    await expect(factory.execute({ id: 'valid', title: '!!!', body: '' }))
      .rejects.toThrow('issue title must contain a letter or number')
  })

  it('bounds the generated branch component for a maximum-length GitHub title', async () => {
    const repo = await repository()
    const run = await new SoloFactory(config(repo), new RecordingRunner())
      .execute({ id: 'long', title: 'a'.repeat(256), body: '' })

    expect(run.branch.split('/').at(-1)?.length).toBeLessThan(128)
  })

  it('reuses an existing pull request for the branch', async () => {
    const repo = await repository()
    const runner = new ExistingPullRequestRunner()

    const run = await new SoloFactory(config(repo), runner)
      .execute({ id: 'existing', title: 'Existing PR', body: 'Reuse it' })

    expect(run.pullRequestUrl).toBe('https://github.com/acme/widget/pull/8')
    expect(runner.calls.map(call => call.command.executable)).not.toContain('open-pr')
  })

  it('reuses a pull request created before a failed lookup', async () => {
    const repo = await repository()
    const runner = new PullRequestRecoveryRunner()
    const factory = new SoloFactory(config(repo), runner)

    await expect(factory.execute({ id: 'recover-pr', title: 'Recover PR', body: 'Open it once' }))
      .rejects.toThrow('lookup interrupted')
    const [failed] = await factory.history()
    expect(failed?.failedStage).toBe('pull-request')

    const resumed = await factory.resume(failed!.id)

    expect(resumed.pullRequestUrl).toBe('https://github.com/acme/widget/pull/9')
    expect(runner.calls.filter(commandName => commandName === 'open-pr')).toHaveLength(1)
    expect(runner.calls.filter(commandName => commandName === 'review')).toHaveLength(1)
  })

  it('records a logical pull-request failure after the create command returns', async () => {
    const repo = await repository()
    const factory = new SoloFactory(config(repo), new MissingPullRequestRunner())

    await expect(factory.execute({ id: 'missing-pr', title: 'Missing PR', body: '' }))
      .rejects.toThrow('was not found after creation')
    const [failed] = await factory.history()
    expect(failed).toMatchObject({ state: 'failed', failedStage: 'pull-request' })
  })

  it('normalizes non-Error command failures in durable results', async () => {
    const repo = await repository()
    const factory = new SoloFactory(config(repo), new NonErrorFailureRunner())

    const failure = await factory.execute({ id: 'string-error', title: 'String error', body: '' })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(FactoryRunError)
    if (!(failure instanceof FactoryRunError)) throw new Error('expected FactoryRunError')
    expect(failure.message).toContain('factory command failed')
    expect(failure.run).toMatchObject({ state: 'failed', failedStage: 'test' })
    const [failed] = await factory.history()
    expect(failed?.events.at(-1)?.detail).toBe('factory command failed')
    expect(failed?.commandResults.at(-1)?.error).toBe('factory command failed')
  })

  it('rejects a second active run for the same issue', async () => {
    const repo = await repository()
    const runner = new BlockingRunner()
    const factory = new SoloFactory(config(repo), runner)
    const issue = { id: 'same', title: 'One issue', body: 'Do it once' }
    const first = factory.execute(issue)
    await runner.entered

    await expect(factory.execute(issue)).rejects.toThrow('already has an active factory run')
    const separate = factory.execute({ id: 'other', title: 'Other issue', body: 'Run separately' })

    runner.unblock()
    const [firstRun, separateRun] = await Promise.all([first, separate])
    expect(firstRun.worktree).not.toBe(separateRun.worktree)
  })

  it('rejects unreadable, unsupported, and path-inconsistent history', async () => {
    const repo = await repository()
    const factoryConfig = config(repo)
    await expect(new SoloFactory({ ...factoryConfig, historyFile: repo }, new RecordingRunner()).history())
      .rejects.toMatchObject({ code: 'EISDIR' })

    await mkdir(join(repo, '.factory'))
    await writeFile(factoryConfig.historyFile, '[]\n')
    await expect(new SoloFactory(factoryConfig, new RecordingRunner()).history())
      .rejects.toThrow('unsupported solo factory history format')

    await writeFile(factoryConfig.historyFile, `${JSON.stringify({
      formatVersion: 0,
      runs: [{
        id: 'enterprise-history',
        issue: { id: '44', title: 'Old workflow', body: '' },
        branch: 'factory/old-workflow',
        worktree: join(factoryConfig.worktreeRoot, 'old-workflow'),
        state: 'released',
        events: [{ at: new Date(0).toISOString(), state: 'released', detail: 'automatic release' }],
        commandResults: [{
          stage: 'merge',
          command: { executable: 'merge', args: [] },
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(0).toISOString(),
          status: 'succeeded',
        }],
      }],
    })}\n`)
    await expect(new SoloFactory(factoryConfig, new RecordingRunner()).history())
      .rejects.toThrow('unsupported solo factory history format')

    await writeFile(factoryConfig.historyFile, '{"formatVersion":0,"runs":[]}\n')
    const factory = new SoloFactory(factoryConfig, new RecordingRunner())
    const run = await factory.execute({ id: 'bad-path', title: 'Bad path', body: '' })
    const document = JSON.parse(await readFile(factoryConfig.historyFile, 'utf8')) as { runs: Array<{ worktree: string }> }
    document.runs[0]!.worktree = repo
    await writeFile(factoryConfig.historyFile, JSON.stringify(document))
    await expect(factory.history()).rejects.toThrow('unsupported solo factory history format')
    await expect(stat(run.worktree)).resolves.toMatchObject({})
  })

  it('rejects runs that are missing or not failed', async () => {
    const repo = await repository()
    const factory = new SoloFactory(config(repo), new RecordingRunner())

    await expect(factory.resume(FactoryRunId('missing'))).rejects.toThrow('is not resumable')
    const completed = await factory.execute({ id: 'complete', title: 'Complete', body: '' })
    await expect(factory.resume(completed.id)).rejects.toThrow('is not resumable')
  })

  it('resumes a minimal failed record from the accepted state', async () => {
    const repo = await repository()
    const factoryConfig = config(repo)
    const branch = 'factory/minimal-run'
    const worktree = join(factoryConfig.worktreeRoot, 'minimal-run')
    await mkdir(factoryConfig.worktreeRoot)
    await writeFile(factoryConfig.historyFile, `${JSON.stringify({
      formatVersion: 0,
      runs: [{
        id: 'minimal',
        issue: { id: 'minimal', title: 'Minimal', body: '' },
        branch,
        worktree,
        state: 'failed',
        events: [{ at: new Date(0).toISOString(), state: 'failed', detail: 'interrupted' }],
        commandResults: [],
        failedStage: 'pull-request',
      }],
    })}\n`)

    const resumed = await new SoloFactory(factoryConfig, new ExistingPullRequestRunner()).resume(FactoryRunId('minimal'))

    expect(resumed.state).toBe('pull-request-open')
    expect(resumed.events.map(event => event.detail)).toContain('resuming pull-request')
  })

  it('rejects a failed record without a failed stage', async () => {
    const repo = await repository()
    const factoryConfig = config(repo)
    const branch = 'factory/no-stage'
    await mkdir(factoryConfig.worktreeRoot)
    await writeFile(factoryConfig.historyFile, `${JSON.stringify({
      formatVersion: 0,
      runs: [{
        id: 'no-stage',
        issue: { id: 'no-stage', title: 'No stage', body: '' },
        branch,
        worktree: join(factoryConfig.worktreeRoot, 'no-stage'),
        state: 'failed',
        events: [],
        commandResults: [],
      }],
    })}\n`)

    await expect(new SoloFactory(factoryConfig, new RecordingRunner()).resume(FactoryRunId('no-stage')))
      .rejects.toThrow('is not resumable')
  })

  it('resumes at the failed stage without repeating completed work', async () => {
    const repo = await repository()
    const runner = new RecordingRunner('test')
    const factory = new SoloFactory(config(repo), runner)

    await expect(factory.execute({ id: '43', title: 'Resume factory', body: 'Recover it' }))
      .rejects.toThrow('test failed')
    const [failed] = await factory.history()
    expect(failed).toMatchObject({ state: 'failed', failedStage: 'test' })
    expect(failed?.commandResults.at(-1)).toMatchObject({
      stage: 'test',
      command: { executable: 'test', args: [] },
      status: 'failed',
      error: 'test failed',
    })
    await expect(stat(failed!.worktree)).resolves.toMatchObject({})

    const resumed = await factory.resume(failed!.id)

    expect(resumed).toMatchObject({
      state: 'pull-request-open',
      pullRequestUrl: 'https://github.com/acme/widget/pull/7',
    })
    expect(runner.calls.map(call => call.command.executable)).toEqual([
      'git', 'git', 'implement', 'test', 'test', 'review', 'gh', 'open-pr', 'gh',
    ])
    expect(resumed.commandResults.filter(result => result.stage === 'test').map(result => result.status))
      .toEqual(['failed', 'succeeded'])
  })

  it('registers its empty invariant companion under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SoloFactoryInvariant)

    expect(() => ctx.invariants.register('@deepseek-ai/dsh-solo-factory', () => {})).toThrow(/already registered/)
  })
})
