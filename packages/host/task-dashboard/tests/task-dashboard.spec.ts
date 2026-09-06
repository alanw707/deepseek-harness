import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import type { Task } from '@deepseek-ai/dsh-task-control'
import TaskDashboard, { type Config } from '../src/index.ts'
import WebServer from '../../webserver/src/index.ts'

interface DashboardHarness {
  readonly ctx: Context
  readonly dispose: () => Promise<void>
  readonly tasks: Map<string, Task>
  readonly projectRoot: string
}

type AuthorizeIndex = (request: unknown, response: unknown) => boolean

async function harness(config: Config = {}, authorizeIndex: AuthorizeIndex = () => true): Promise<DashboardHarness> {
  const ctx = new Context()
  const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-task-dashboard-'))
  const tasks = new Map<string, Task>()
  const workspaces = new Map<string, { id: string; title: string; path: string }>()
  let sequence = 0
  ctx.provide('connection', { authorizeIndex } as never)
  ctx.provide('taskControl', {
    list: () => [...tasks.values()],
    listProjects: () => [...workspaces.values()],
    registerProject: async (path: string) => {
      for (const project of workspaces.values()) {
        if (path.startsWith(`${project.path}/`) || project.path.startsWith(`${path}/`)) throw new Error('project path overlaps approved project')
      }
      const workspace = { id: `workspace-${String(++sequence)}`, title: path, path }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
    create: async (request: Omit<Task, 'id' | 'state' | 'createdAt' | 'updatedAt'>) => {
      const now = new Date().toISOString()
      const task: Task = { ...request, id: `task-${String(++sequence)}` as Task['id'], state: 'pending-approval', createdAt: now, updatedAt: now }
      tasks.set(task.id, task)
      return task
    },
    approve: async (id: Task['id']) => {
      if (id === 'string-error') throw 'string error'
      const task = tasks.get(id)
      if (task === undefined) throw new Error('missing task')
      const next = { ...task, state: 'queued' as const, approval: { approvedAt: new Date().toISOString() } }
      tasks.set(id, next)
      return next
    },
  } as never)
  ctx.provide('taskExecution', {
    run: async (id: Task['id']) => {
      const task = tasks.get(id)
      if (task === undefined) throw new Error('missing task')
      const next = { ...task, state: 'running' as const }
      tasks.set(id, next)
      return next
    },
    cancel: async (id: Task['id']) => {
      const task = tasks.get(id)
      if (task === undefined) throw new Error('missing task')
      const next = { ...task, state: 'cancelled' as const }
      tasks.set(id, next)
      return next
    },
    review: async (id: Task['id']) => {
      const task = tasks.get(id)
      if (task?.copy?.changes === undefined) throw new Error('missing task changes')
      return {
        sha256: task.copy.changes.sha256,
        changes: [{
          path: 'file.txt', kind: 'modify',
          before: { type: 'file', mode: 0o644, text: 'before', sha256: 'a'.repeat(64), size: 6 },
          after: { type: 'file', mode: 0o644, text: 'after', sha256: 'b'.repeat(64), size: 5 },
        }],
      }
    },
    apply: async (id: Task['id'], sha256: string) => {
      const task = tasks.get(id)
      if (task?.copy?.changes?.sha256 !== sha256) throw new Error('wrong change digest')
      const next: Task = { ...task, copy: { ...task.copy, changes: { ...task.copy.changes, state: 'applied' } } }
      tasks.set(id, next)
      return next
    },
  } as never)
  const web = await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  let dashboard: { dispose(): Promise<void> }
  try {
    dashboard = await ctx.plugin(TaskDashboard, config)
  } catch (error) {
    await web.dispose()
    await rm(projectRoot, { recursive: true, force: true })
    throw error
  }
  return {
    ctx,
    tasks,
    projectRoot,
    dispose: async () => { await dashboard.dispose(); await web.dispose(); await rm(projectRoot, { recursive: true, force: true }) },
  }
}

class SilentWebSocket {
  static readonly OPEN = 1
  readonly readyState = SilentWebSocket.OPEN
  addEventListener(): void {}
  send(): void {}
  close(): void {}
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
})

function endpoint(ctx: Context, path: string): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}${path}`
}

describe('TaskDashboard', () => {
  it('serves an authenticated local dashboard and controls project tasks', async () => {
    const result = await harness()
    disposals.push(result.dispose)
    const page = await fetch(endpoint(result.ctx, '/command-center'))
    expect(page.status).toBe(200)
    const html = await page.text()
    const csrf = /const csrf="([A-Za-z0-9_-]+)"/u.exec(html)?.[1]
    const cookie = page.headers.get('set-cookie')
    if (csrf === undefined || cookie === null) throw new Error('dashboard page did not return session credentials')
    expect(cookie).toContain('HttpOnly')
    expect(html).toContain('setInterval(()=>{void render()},1000)')
    const injections = result.ctx.webServer.collectIndexInjections()
    expect(injections).toHaveLength(1)
    expect(injections[0]).toMatchObject({ kind: 'html', placement: 'body' })
    expect(JSON.stringify(injections[0])).toContain('Chat')
    expect(html.replace(csrf, '<csrf>')).toMatchSnapshot()
    const headers = { cookie, 'x-dsh-csrf': csrf, 'content-type': 'application/json' }

    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'))).resolves.toMatchObject({ status: 401 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie } })).resolves.toMatchObject({ status: 200 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers: { cookie }, body: '{}' })).resolves.toMatchObject({ status: 403 })

    const projectPath = join(result.projectRoot, 'project')
    await mkdir(projectPath)
    const workspace = await fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers, body: JSON.stringify({ path: projectPath }) })
    expect(workspace.status).toBe(201)
    const workspaceId = (await workspace.json() as { workspace: { id: string } }).workspace.id
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie } })).resolves.toMatchObject({ status: 200 })

    const created = await fetch(endpoint(result.ctx, '/command-center/api/tasks'), {
      method: 'POST', headers, body: JSON.stringify({ workspaceId, executor: 'pi', instruction: 'inspect project' }),
    })
    expect(created.status).toBe(201)
    const taskId = (await created.json() as { task: { id: string } }).task.id
    const identifiedState = await fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie } })
    expect(await identifiedState.json()).toMatchObject({ tasks: [{ workspace: { id: workspaceId, path: projectPath } }] })

    for (const action of ['approve', 'run', 'cancel']) {
      const response = await fetch(endpoint(result.ctx, `/command-center/api/tasks/${taskId}/${action}`), { method: 'POST', headers, body: '{}' })
      expect(response.status).toBe(200)
    }
    expect(result.tasks.get(taskId)).toMatchObject({ state: 'cancelled' })

    const nested = join(projectPath, 'nested')
    await mkdir(nested)
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), {
      method: 'POST', headers, body: JSON.stringify({ path: nested }),
    })).resolves.toMatchObject({ status: 400 })

    const reviewedId = 'reviewed-task' as Task['id']
    result.tasks.set(reviewedId, {
      id: reviewedId,
      workspaceId: workspaceId as Task['workspaceId'],
      executor: 'pi', origin: 'dashboard', instruction: 'edit file', state: 'succeeded',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      copy: {
        root: '/private/task', original: projectPath, manifestSha256: 'c'.repeat(64),
        changes: { sha256: 'd'.repeat(64), count: 1, state: 'pending-review' },
      },
    })
    const review = await fetch(endpoint(result.ctx, `/command-center/api/tasks/${reviewedId}/changes`), { headers: { cookie } })
    expect(review.status).toBe(200)
    expect(await review.json()).toMatchObject({ sha256: 'd'.repeat(64), changes: [{ path: 'file.txt' }] })
    const applied = await fetch(endpoint(result.ctx, `/command-center/api/tasks/${reviewedId}/apply`), {
      method: 'POST', headers, body: JSON.stringify({ sha256: 'd'.repeat(64) }),
    })
    expect(applied.status).toBe(200)
    expect(result.tasks.get(reviewedId)?.copy?.changes?.state).toBe('applied')
  })

  it('preserves manually opened and closed output through refresh and task updates', async () => {
    const result = await harness()
    disposals.push(result.dispose)
    const page = await fetch(endpoint(result.ctx, '/command-center'))
    const html = await page.text()
    const dom = new JSDOM(html, { runScripts: 'outside-only' })
    disposals.push(async () => { dom.window.close() })
    let detail = 'first output'
    dom.window.fetch = async () => new Response(JSON.stringify({
      workspaces: [],
      tasks: [{ id: 'stable-task', executor: 'pi', state: 'failed', instruction: 'inspect', updatedAt: '2026-01-01T00:00:00Z', detail }],
    }))
    const script = dom.window.document.querySelector('script')!.textContent
    vi.spyOn(dom.window, 'setInterval').mockReturnValue(1)
    const context = dom.getInternalVMContext()
    runInContext(script, context)
    const refresh = async (): Promise<void> => { await runInContext('render()', context) }
    await refresh()
    const output = (): HTMLDetailsElement => dom.window.document.querySelector('.output-viewer')!
    output().open = true
    const scroll = output().querySelector('.output-scroll')!
    scroll.scrollTop = 137
    await refresh()
    expect(output().open).toBe(true)
    expect(output().querySelector('.output-scroll')?.scrollTop).toBe(137)
    detail = 'updated output'
    await refresh()
    expect(output().open).toBe(true)
    expect(output().textContent).toContain('updated output')
    output().open = false
    await refresh()
    expect(output().open).toBe(false)
  })

  it('shows a recovery action when the dashboard session expires', async () => {
    const result = await harness()
    disposals.push(result.dispose)
    const page = await fetch(endpoint(result.ctx, '/command-center'))
    const dom = new JSDOM(await page.text(), { runScripts: 'outside-only' })
    disposals.push(async () => { dom.window.close() })
    dom.window.fetch = async () => new Response('', { status: 401 })
    vi.spyOn(dom.window, 'setInterval').mockReturnValue(1)
    const context = dom.getInternalVMContext()
    runInContext(dom.window.document.querySelector('script')!.textContent, context)
    await runInContext('render().catch(showError)', context)
    expect(dom.window.document.querySelector<HTMLElement>('#notice')?.hidden).toBe(false)
    expect(dom.window.document.querySelector('#notice-message')?.textContent).toContain('session expired')
    expect(dom.window.document.querySelector<HTMLElement>('#reload')?.hidden).toBe(false)
  })

  it('shows project identity, waiting-task cancellation, and exact change approval', async () => {
    const result = await harness()
    disposals.push(result.dispose)
    const page = await fetch(endpoint(result.ctx, '/command-center'))
    const dom = new JSDOM(await page.text(), { runScripts: 'outside-only' })
    disposals.push(async () => { dom.window.close() })
    let task: Record<string, unknown> = {
      id: 'task-review', workspaceId: 'workspace-1', executor: 'pi', state: 'pending-approval', instruction: 'edit',
      updatedAt: '2026-01-01T00:00:00Z', workspace: { id: 'workspace-1', title: 'My project', path: '/projects/mine' },
    }
    let appliedDigest: string | undefined
    const lifecycleCalls: string[] = []
    dom.window.fetch = async (input, init) => {
      if (typeof input !== 'string') throw new Error('expected dashboard fetch path')
      const path = input
      if (path.endsWith('/state')) return new Response(JSON.stringify({ workspaces: [], tasks: [task] }))
      if (path.endsWith('/changes')) return new Response(JSON.stringify({
        sha256: 'd'.repeat(64),
        changes: [{
          path: 'file.txt', kind: 'modify',
          before: { type: 'file', mode: 420, text: 'before' },
          after: { type: 'file', mode: 420, text: 'after' },
        }],
      }))
      if (path.endsWith('/approve') || path.endsWith('/run')) {
        lifecycleCalls.push(path.slice(path.lastIndexOf('/') + 1))
        return new Response(JSON.stringify({ task }))
      }
      if (path.endsWith('/apply')) {
        if (typeof init?.body !== 'string') throw new Error('expected dashboard apply body')
        appliedDigest = (JSON.parse(init.body) as { sha256: string }).sha256
        task = { ...task, copy: { changes: { sha256: appliedDigest, count: 1, state: 'applied' } } }
        return new Response(JSON.stringify({ task }))
      }
      return new Response(JSON.stringify({ task }))
    }
    vi.spyOn(dom.window, 'setInterval').mockReturnValue(1)
    const context = dom.getInternalVMContext()
    runInContext(dom.window.document.querySelector('script')!.textContent, context)
    await runInContext('render()', context)
    expect(dom.window.document.querySelector('.project')?.textContent).toBe('My project')
    expect([...dom.window.document.querySelectorAll('.actions button')].map(node => node.textContent)).toEqual(['Approve & start Pi', 'Cancel task'])
    await runInContext("document.querySelector('.actions button').onclick()", context)
    expect(lifecycleCalls).toEqual(['approve', 'run'])

    task = { ...task, state: 'succeeded', copy: { changes: { sha256: 'd'.repeat(64), count: 1, state: 'pending-review' } } }
    await runInContext('render()', context)
    await runInContext("document.querySelector('.change-review button').onclick()", context)
    expect([...dom.window.document.querySelectorAll('.diff-pane pre')].map(node => node.textContent)).toEqual(['before', 'after'])
    await runInContext("document.querySelector('.change-apply').onclick()", context)
    expect(appliedDigest).toBe('d'.repeat(64))
  })

  it('rejects malformed, expired, and unauthorized requests without mutating tasks', async () => {
    const denied = await harness({}, (_request, response) => {
      const output = response as { writeHead: (status: number) => void; end: (body: string) => void }
      output.writeHead(401)
      output.end('authentication required')
      return false
    })
    disposals.push(denied.dispose)
    await expect(fetch(endpoint(denied.ctx, '/command-center'))).resolves.toMatchObject({ status: 401 })

    const result = await harness()
    disposals.push(result.dispose)
    await expect(fetch(endpoint(result.ctx, '/command-center'), { method: 'POST' })).resolves.toMatchObject({ status: 404 })
    await expect(fetch(endpoint(result.ctx, '/command-center'), { headers: { host: 'localhost' } })).resolves.toMatchObject({ status: 200 })
    const page = await fetch(endpoint(result.ctx, '/command-center'))
    const csrf = /const csrf=("[^"]+")/u.exec(await page.text())?.[1]
    const cookie = page.headers.get('set-cookie')!
    const headers = { cookie, 'x-dsh-csrf': JSON.parse(csrf!) as string, 'content-type': 'application/json' }

    await expect(fetch(endpoint(result.ctx, '/command-center/api/missing'), { headers: { cookie } })).resolves.toMatchObject({ status: 403 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie: 'unrelated=value' } })).resolves.toMatchObject({ status: 401 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/missing'), { method: 'POST', headers, body: '{}' })).resolves.toMatchObject({ status: 404 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks/string-error/approve'), { method: 'POST', headers, body: '{}' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers, body: 'null' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers, body: '[]' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers, body: '{}' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks'), { method: 'POST', headers, body: JSON.stringify({ executor: 'nope' }) })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks'), { method: 'POST', headers, body: JSON.stringify({ executor: 'pi' }) })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks'), { method: 'POST', headers, body: JSON.stringify({ executor: 'pi', workspaceId: 'workspace' }) })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks'), { method: 'POST', headers, body: '{' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks'), { method: 'POST', headers, body: JSON.stringify({ executor: 'pi', workspaceId: 'workspace', instruction: 'x'.repeat(17 * 1024) }) })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks/missing/apply'), {
      method: 'POST', headers, body: JSON.stringify({ sha256: 'bad' }),
    })).resolves.toMatchObject({ status: 400 })

    const orphanId = 'orphan' as Task['id']
    result.tasks.set(orphanId, {
      id: orphanId, workspaceId: 'unknown' as Task['workspaceId'], executor: 'pi', origin: 'dashboard',
      instruction: 'historical', state: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    })
    const state = await fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie } })
    const orphan = (await state.json() as { tasks: Array<{ id: string; workspace?: unknown }> }).tasks.find(task => task.id === orphanId)
    expect(orphan).toEqual(expect.objectContaining({ id: orphanId }))
    expect(orphan).not.toHaveProperty('workspace')

    const privateDashboard = result.ctx.taskDashboard as unknown as { sessions: Map<string, { csrf: string; expiresAt: number }> }
    privateDashboard.sessions.set('expired', { csrf: 'csrf', expiresAt: 0 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie: 'dsh_command_center_session=expired' } })).resolves.toMatchObject({ status: 401 })
  })

  it('requires a complete valid Discord allowlist and wires optional ingress cleanup', async () => {
    const invalid: Config[] = [
      { discordToken: 'token' },
      { discordToken: 'token', discordUserId: '12345678901234567' },
      { discordToken: 'token', discordUserId: '12345678901234567', discordGuildIds: ['12345678901234567'] },
      { discordToken: 'token', discordUserId: 'bad', discordGuildIds: ['12345678901234567'], discordChannelIds: ['12345678901234567'] },
      { discordToken: 'token', discordUserId: '12345678901234567', discordGuildIds: ['bad'], discordChannelIds: ['12345678901234567'] },
      { discordToken: 'token', discordUserId: '12345678901234567', discordGuildIds: ['12345678901234567'], discordChannelIds: ['bad'] },
    ]
    for (const config of invalid) await expect(harness(config)).rejects.toThrow(/Discord|snowflake/u)

    const previous = globalThis.WebSocket
    globalThis.WebSocket = SilentWebSocket as unknown as typeof WebSocket
    try {
      const result = await harness({
        discordToken: 'token', discordUserId: '12345678901234567',
        discordGuildIds: ['12345678901234567'], discordChannelIds: ['12345678901234567'], discordPrefix: '!tasks',
      })
      await result.dispose()
      const defaultPrefix = await harness({
        discordToken: 'token', discordUserId: '12345678901234567',
        discordGuildIds: ['12345678901234567'], discordChannelIds: ['12345678901234567'],
      })
      await defaultPrefix.dispose()
    } finally {
      globalThis.WebSocket = previous
    }
  })

  it('rejects a non-loopback web server before it registers routes', () => {
    const ctx = new Context()
    ctx.provide('webServer', { host: '0.0.0.0' } as never)
    expect(() => new TaskDashboard(ctx, {})).toThrow('127.0.0.1')
  })

  it('defends direct malformed requests', async () => {
    const result = await harness()
    disposals.push(result.dispose)
    const dashboard = result.ctx.taskDashboard as unknown as {
      api: (request: unknown, response: unknown) => Promise<void>
      page: (request: unknown, response: unknown) => void
      sessions: Map<string, { csrf: string; expiresAt: number }>
    }
    const statuses: number[] = []
    const response = { writeHead: (status: number) => statuses.push(status), end: () => undefined }
    await dashboard.api({ headers: { host: 'example.test' }, [Symbol.asyncIterator]: async function* () { yield 'ignored' } }, response)
    dashboard.page({ method: 'GET', headers: { host: 'example.test' } }, response)
    dashboard.sessions.set('direct', { csrf: 'csrf', expiresAt: Number.MAX_SAFE_INTEGER })
    await dashboard.api({ method: 'POST', headers: { host: '127.0.0.1', cookie: 'dsh_command_center_session=direct', 'x-dsh-csrf': 'csrf' }, [Symbol.asyncIterator]: async function* () { yield '{}' } }, response)
    expect(statuses).toEqual([404, 404, 404])
  })
})
