// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TaskDashboardView, type TaskDashboardViewProps } from '../src/client/TaskDashboardView.tsx'
import { TaskNavigation, type TaskNavigationProps } from '../src/client/TaskNavigation.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'sidebar.primary.action': { kind: 'list', scope: 'root' },
      'conversation.route': { kind: 'chain', scope: 'root' },
    },
  } as never, () => null)
}

describe('task-dashboard browser plugin', () => {
  it('registers localized Software Factory navigation and route and removes them on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    const declaration = declare(slots)
    ctx.provide('locale', new LocaleRuntime(ctx))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(inject).toEqual(['slots', 'locale'])
    const entry = slots.entries('sidebar.primary.action')[0]
    expect(entry?.component).toBe(TaskNavigation)
    expect(entry?.options).toMatchObject({ id: 'task-dashboard' })

    await fiber.dispose()
    expect(slots.entries('sidebar.primary.action')).toHaveLength(0)
    expect(slots.entries('conversation.route')).toHaveLength(0)
    declaration()
  })

  it.each([true, false])('renders the command-center route as a %s sidebar action', (wide) => {
    const props = {
      wide,
      className: 'sidebar-action',
      t: (key: keyof typeof en) => en[key],
    } as unknown as TaskNavigationProps
    const view = render(<TaskNavigation {...props} />)
    const link = view.getByRole('link', { name: 'Software Factory' })
    expect(link).toMatchObject({ className: 'sidebar-action' })
    expect(link.getAttribute('href')).toBe('/command-center')
    expect(link.getAttribute('aria-current')).toBeNull()
    expect(link.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+T')
    expect(link.querySelector('svg')).not.toBeNull()
  })

  it('navigates the current shell route from the keyboard shortcut', () => {
    const original = window.location.pathname
    window.history.replaceState({}, '', '/')
    const props = {
      wide: true,
      className: 'sidebar-action',
      t: (key: keyof typeof en) => en[key],
    } as unknown as TaskNavigationProps
    const view = render(<TaskNavigation {...props} />)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true }))
    expect(window.location.pathname).toBe('/command-center')
    view.rerender(<TaskNavigation {...props} />)
    expect(view.getByRole('link').getAttribute('aria-current')).toBe('page')
    window.history.replaceState({}, '', original)
  })

  it('renders the dashboard inside the route slot after opening its host session', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/session')) return new Response(JSON.stringify({ csrf: 'csrf' }), { status: 200 })
      if (url.endsWith('/state')) return new Response(JSON.stringify({ workspaces: [], tasks: [] }), { status: 200 })
      throw new Error(`unexpected request ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    const t = ((key: keyof typeof en, params?: Record<string, unknown>) => {
      let value = en[key]
      for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
      return value
    }) as TaskDashboardViewProps['t']
    const props = { matched: true, pathname: '/command-center', t } as unknown as TaskDashboardViewProps
    render(<TaskDashboardView {...props} />)
    await waitFor(() => {
      expect(document.getElementById('software-factory-title')?.textContent).toBe(en.moveWork)
    })
    expect(document.querySelector('main')?.className).toBeTruthy()
    expect(fetch).toHaveBeenCalledWith('/command-center/api/session', { credentials: 'same-origin' })
  })
})
