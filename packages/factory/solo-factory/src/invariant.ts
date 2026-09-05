/** Package-owned invariant companion for `@deepseek-ai/dsh-solo-factory`. @module @deepseek-ai/dsh-solo-factory/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-solo-factory'

/** Cordis companion plugin name. */
export const name = 'solo-factory-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: each run record is validated when read and changes only under the history-file lock. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx Cordis context carrying the invariant service.
 * @returns The registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
