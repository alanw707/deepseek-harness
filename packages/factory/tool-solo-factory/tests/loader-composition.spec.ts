import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ToolSoloFactory from '../src/index.ts'
import * as ToolSoloFactoryInvariant from '../src/invariant.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-solo-factory-loader-'))
  const configPath = join(root, 'cordis.yml')
  const command = `{ executable: ${JSON.stringify(process.execPath)}, args: [--version] }`
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-solo-factory'",
    '  config:',
    `    repository: ${JSON.stringify(root)}`,
    `    worktreeRoot: ${JSON.stringify(join(root, 'worktrees'))}`,
    `    historyFile: ${JSON.stringify(join(root, 'runs.json'))}`,
    '    branchPrefix: factory',
    `    implement: ${command}`,
    `    test: ${command}`,
    `    review: ${command}`,
    `    pullRequest: ${command}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-solo-factory', ToolSoloFactory],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-solo-factory real Loader composition through cordis.yml', () => {
  it('publishes only start and resume operations for the issue-to-PR flow', async () => {
    const ctx = await boot()
    const schemas = ctx.tools.schemas().filter(schema => schema.name.startsWith('factory_'))

    expect(schemas.map(schema => schema.name)).toEqual(['factory_run', 'factory_resume'])
    expect(schemas.map(schema => schema.description).join(' ')).toContain('pull request')
    expect(schemas.map(schema => schema.description).join(' ')).not.toMatch(/merge|release/)
  })

  it('registers its empty invariant companion under the package name', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(ToolSoloFactoryInvariant)

    expect(() => ctx.invariants.register('@deepseek-ai/dsh-tool-solo-factory', () => {})).toThrow(/already registered/)
  })
})
