/** Package-owned invariant companion for `@deepseek-ai/dsh-tool-solo-factory`. @module @deepseek-ai/dsh-tool-solo-factory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-solo-factory'

/** Cordis companion plugin name. */
export const name = 'tool-solo-factory-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the tool registry owns registrations and Loader composition tests prove this plugin's two contributions. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx Cordis context carrying the invariant service.
 * @returns The registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
