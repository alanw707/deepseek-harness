/** Browser plugin contributing the Software Factory route and navigation. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { TaskDashboardView } from './TaskDashboardView.tsx'
import { TaskNavigation } from './TaskNavigation.tsx'
import { en, NS, zh, type TaskDashboardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task-dashboard browser navigation copy. */
    'task-dashboard': TaskDashboardKey
  }
}

/** Services required by task-dashboard browser navigation. */
export const inject = ['slots', 'locale']

/**
 * Register the localized Software Factory route and sidebar navigation.
 * @param ctx - Browser context carrying slots and locale services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'task-dashboard: browser dictionaries')
  ctx.slots.inject('sidebar.primary.action', () => ctx.slots.register({
    name: 'sidebar.primary.action',
    id: 'task-dashboard',
    locale: NS,
  }, TaskNavigation))
  ctx.slots.inject('conversation.route', () => ctx.slots.register({
    name: 'conversation.route',
    locale: NS,
    select: ({ pathname }) => pathname === '/command-center' ? true : null,
  }, TaskDashboardView))
}
