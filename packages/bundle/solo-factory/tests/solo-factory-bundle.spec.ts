import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SoloFactoryBundleInvariant from '../src/invariant.ts'

describe('solo-factory profile bundle', () => {
  it('mounts implementation, focused-test, review, and pull-request stages', () => {
    expect(PROFILE_TEMPLATES['headless-solo-factory']).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-codex', '@deepseek-ai/dsh-solo-factory-bundle'],
      patchReload: 'startup',
    })
    const root = fileURLToPath(new URL('..', import.meta.url))
    const patch = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    if (!Array.isArray(patch)) throw new Error('factory bundle patch must be a patch list')
    const rows = patch.flatMap(entry => (entry as { insert?: Record<string, unknown>[] }).insert ?? [])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'solo-factory', name: '@deepseek-ai/dsh-tool-solo-factory' })
    const source = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(source).toContain('"executable":"dsh"')
    expect(source).toContain('"executable":"pnpm"')
    expect(source).toContain('"executable":"gh"')
    expect(source).toContain('"--changed","origin/HEAD"')
    expect(source.match(/GitHub issue #\{issue\}: \{title\}/g)).toHaveLength(2)
    expect(source.match(/Requirements: \{body\}/g)).toHaveLength(2)
    expect(source).not.toContain('DSH_FACTORY_MERGE')
    expect(source).not.toContain('DSH_FACTORY_RELEASE')
  })

  it('registers its empty invariant companion under the package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SoloFactoryBundleInvariant)

    expect(() => ctx.invariants.register('@deepseek-ai/dsh-solo-factory-bundle', () => {})).toThrow(/already registered/)
  })
})
