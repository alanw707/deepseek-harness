import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { SoloFactoryConfig } from '@deepseek-ai/dsh-solo-factory'

const factory = vi.hoisted(() => {
  class MockFactoryRunError extends Error {
    constructor(readonly run: object) { super('factory run failed') }
  }
  return {
    execute: vi.fn(),
    resume: vi.fn(),
    FactoryRunError: MockFactoryRunError,
  }
})

vi.mock('@deepseek-ai/dsh-solo-factory', () => ({
  FactoryRunError: factory.FactoryRunError,
  FactoryRunId: (value: string) => value,
  SoloFactory: class {
    execute = factory.execute
    resume = factory.resume
  },
}))

const ToolSoloFactory = await import('../src/index.ts')
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.clearAllMocks()
})

function config(): SoloFactoryConfig {
  const inert = { executable: 'inert', args: [] }
  return {
    repository: '/repository',
    worktreeRoot: '/worktrees',
    historyFile: '/runs.json',
    branchPrefix: 'factory',
    implement: inert,
    test: inert,
    review: inert,
    pullRequest: inert,
  }
}

describe('tool-solo-factory Consumers', () => {
  it('starts and renders a completed factory run', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(ToolSoloFactory, config()).await()
    factory.execute.mockResolvedValue({
      id: 'run-1', state: 'pull-request-open', pullRequestUrl: 'https://github.com/acme/widget/pull/1', worktree: '/worktrees/run-1',
    })
    const tool = ctx.tools.get('factory_run')!

    const value = await tool.execute({ id: '1', title: 'Issue', body: 'Requirements' }, {} as never)

    expect(factory.execute).toHaveBeenCalledWith({ id: '1', title: 'Issue', body: 'Requirements' })
    expect(value).toBe('factory run run-1 pull-request-open: https://github.com/acme/widget/pull/1')
    expect(tool.output.render({}, value as string)).toEqual([{ type: 'text', text: value }])
  })

  it('returns the failed run id, stage, and worktree for resume', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(ToolSoloFactory, config()).await()
    factory.execute.mockRejectedValue(new factory.FactoryRunError({
      id: 'run-failed', state: 'failed', failedStage: 'test', worktree: '/worktrees/run-failed',
    }))
    const tool = ctx.tools.get('factory_run')!

    const value = await tool.execute({ id: '2', title: 'Failing issue', body: 'Requirements' }, {} as never)

    expect(value).toBe('factory run run-failed failed at test: /worktrees/run-failed')
  })

  it('rejects failures that have no durable run handoff', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(ToolSoloFactory, config()).await()
    factory.execute.mockRejectedValue(new Error('configuration invalid'))
    const tool = ctx.tools.get('factory_run')!

    await expect(tool.execute({ id: '3', title: 'Invalid config', body: '' }, {} as never))
      .rejects.toThrow('configuration invalid')
  })

  it('brands the id and returns another recorded failure from resume', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt).await()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(ToolSoloFactory, config()).await()
    factory.resume.mockRejectedValue(new factory.FactoryRunError({
      id: 'run-2', state: 'failed', failedStage: 'review', worktree: '/worktrees/run-2',
    }))
    const tool = ctx.tools.get('factory_resume')!

    const value = await tool.execute({ runId: 'run-2' }, {} as never)

    expect(factory.resume).toHaveBeenCalledWith('run-2')
    expect(value).toBe('factory run run-2 failed at review: /worktrees/run-2')
    expect(tool.output.render({}, value as string)).toEqual([{ type: 'text', text: value }])
  })
})
