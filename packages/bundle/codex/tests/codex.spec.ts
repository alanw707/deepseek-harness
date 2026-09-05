import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as CodexBundleInvariant from '../src/invariant.ts'

/** The Codex bundle selects only pi-ai's installed OAuth-backed catalog route. */
describe('dsh-codex bundle', () => {
  it('selects the Codex catalog route and main-agent default model', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')) as Array<Record<string, unknown>>
    expect(patch).toContainEqual({ id: 'llm-pi-ai', config: { providers: { 'openai-codex': {} } } })
    expect(patch).toContainEqual({ id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-5.6-luna' } })
  })

  it('registers its empty invariant companion under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CodexBundleInvariant)

    expect(() => ctx.invariants.register('@deepseek-ai/dsh-codex', () => {})).toThrow(/already registered/)
  })
})
