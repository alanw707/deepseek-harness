/** Package-owned invariant companion for `@deepseek-ai/dsh-solo-factory-bundle`. @module @deepseek-ai/dsh-solo-factory-bundle/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-solo-factory-bundle'

/** Cordis companion plugin name. */
export const name = 'solo-factory-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the bundle contains only Loader patch rows, verified by profile and patch-composition tests. */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx Cordis context carrying the invariant service.
 * @returns The registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
