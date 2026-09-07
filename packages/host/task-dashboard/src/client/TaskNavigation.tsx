/** Software Factory route entry rendered in the sidebar primary-action slot. */

import { useEffect } from 'react'
import { IconListPenOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS } from './locales.ts'

/** Props composed from the sidebar action slot and task-dashboard locale. */
export type TaskNavigationProps =
  PropsRuntime<'sidebar.primary.action'> & PropsLocale<typeof NS>

/**
 * Render the Software Factory route as a normal global link and expose its keyboard shortcut.
 * @param props - Sidebar presentation and localized text.
 * @returns A route link in the sidebar.
 */
export function TaskNavigation({ wide, className, t }: TaskNavigationProps) {
  const label = t('softwareFactory')
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        if (window.location.pathname !== '/command-center') {
          window.history.pushState({}, '', '/command-center')
          window.dispatchEvent(new PopStateEvent('popstate'))
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <a
        className={className}
        href="/command-center"
        aria-label={label}
        aria-current={window.location.pathname === '/command-center' ? 'page' : undefined}
        aria-keyshortcuts="Control+Shift+T"
      >
        <span aria-hidden="true"><IconListPenOutline16 size={wide ? 16 : 18} /></span>
        {wide && <span>{label}</span>}
      </a>
    </Tooltip>
  )
}
