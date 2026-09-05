/**
 * Model-facing start and resume operations for the local solo factory.
 * @module @deepseek-ai/dsh-tool-solo-factory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FactoryRunError, FactoryRunId, SoloFactory, type FactoryRun, type SoloFactoryConfig } from '@deepseek-ai/dsh-solo-factory'

const CommandSchema = z.object({ executable: z.string().min(1).required(), args: z.array(z.string()).required() })

/** Deployment configuration for the model-facing solo-factory Consumers. */
export interface Config extends SoloFactoryConfig {}

/** Validate the repository paths and shell-free command vectors at profile load. */
export const Config: z<Config> = z.object({
  repository: z.string().min(1).required(),
  worktreeRoot: z.string().min(1).required(),
  historyFile: z.string().min(1).required(),
  branchPrefix: z.string().min(1).required(),
  implement: CommandSchema.required(),
  test: CommandSchema.required(),
  review: CommandSchema.required(),
  pullRequest: CommandSchema.required(),
}) as unknown as z<Config>

function renderRun(run: FactoryRun): string {
  const stage = run.failedStage === undefined ? '' : ` at ${run.failedStage}`
  return `factory run ${run.id} ${run.state}${stage}: ${run.pullRequestUrl ?? run.worktree}`
}

async function renderOutcome(operation: () => Promise<FactoryRun>): Promise<string> {
  try {
    return renderRun(await operation())
  } catch (error) {
    if (error instanceof FactoryRunError) return renderRun(error.run)
    throw error
  }
}

/**
 * Mount tools that start and resume the configured issue-to-pull-request pipeline.
 * @param ctx Cordis context carrying the tool registry.
 * @param config Repository, history, worktree, and command configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const factory = new SoloFactory(config)
  ctx.tools.register(defineTool({
    name: 'factory_run',
    description: 'Start the solo software factory for one issue. It creates an isolated Git worktree, plans and implements the issue, runs focused tests and review, opens a pull request, and returns the run id and worktree when a recorded stage fails.',
    parameters: {
      id: { type: 'string', required: true, description: 'GitHub issue identifier.' },
      title: { type: 'string', required: true, description: 'GitHub issue title.' },
      body: { type: 'string', required: true, description: 'GitHub issue requirements.' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    async execute(args) {
      return await renderOutcome(() => factory.execute({ id: args.id, title: args.title, body: args.body }))
    },
  }))
  ctx.tools.register(defineTool({
    name: 'factory_resume',
    description: 'Resume a failed solo-factory run at its failed stage in the existing worktree, then continue through pull-request creation. Another recorded failure returns the same resumable run id.',
    parameters: {
      runId: { type: 'string', required: true, description: 'Failed factory run identifier.' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
    },
    async execute(args) {
      return await renderOutcome(() => factory.resume(FactoryRunId(args.runId)))
    },
  }))
}

export const name = 'tool-solo-factory'
export const inject = ['tools']
