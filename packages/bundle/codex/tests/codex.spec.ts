import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'

/** The Codex bundle selects only pi-ai's installed OAuth-backed catalog route. */
describe('dsh-codex bundle', () => {
  it('selects the Codex catalog route and main-agent default model', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')) as Array<Record<string, unknown>>
    expect(patch).toContainEqual({ id: 'llm-pi-ai', config: { providers: { 'openai-codex': {} } } })
    expect(patch).toContainEqual({ id: 'agent-default-model', config: { provider: 'openai-codex', model: 'gpt-5.6-luna' } })
  })

})
