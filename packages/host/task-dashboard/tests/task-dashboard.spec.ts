import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Task } from '@deepseek-ai/dsh-task-control'
import TaskDashboard, { type Config } from '../src/index.ts'
import WebServer from '../../webserver/src/index.ts'

type AuthorizeIndex = (request: unknown, response: unknown) => boolean

interface DashboardHarness {
  readonly ctx: Context
  readonly dispose: () => Promise<void>
  readonly tasks: Map<string, Task>
  readonly projectRoot: string
}

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

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map(dispose => dispose()))
  vi.unstubAllGlobals()
})

function endpoint(ctx: Context, path: string): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}${path}`
}

async function openSession(ctx: Context): Promise<{ csrf: string; cookie: string }> {
  const response = await fetch(endpoint(ctx, '/command-center/api/session'))
  expect(response.status).toBe(200)
  const body = await response.json() as { csrf?: unknown }
  const setCookie = response.headers.get('set-cookie')
  if (typeof body.csrf !== 'string' || setCookie === null) throw new Error('session did not return browser credentials')
  return { csrf: body.csrf, cookie: setCookie.split(';', 1)[0]! }
}

describe('TaskDashboard', () => {
  it('owns only the authenticated API and leaves the shell route to frontend-static', async () => {
    const result = await harness()
    disposals.push(result.dispose)
    expect((await fetch(endpoint(result.ctx, '/command-center'))).status).toBe(404)
    expect(result.ctx.webServer.collectIndexInjections()).toHaveLength(0)

    const session = await openSession(result.ctx)
    const headers = { cookie: session.cookie, 'x-dsh-csrf': session.csrf, 'content-type': 'application/json' }
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'))).resolves.toMatchObject({ status: 401 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie: session.cookie } })).resolves.toMatchObject({ status: 200 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers: { cookie: session.cookie }, body: '{}' })).resolves.toMatchObject({ status: 403 })

    const projectPath = join(result.projectRoot, 'project')
    await mkdir(projectPath)
    const workspace = await fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers, body: JSON.stringify({ path: projectPath }) })
    expect(workspace.status).toBe(201)
    const workspaceId = (await workspace.json() as { workspace: { id: string } }).workspace.id
    const created = await fetch(endpoint(result.ctx, '/command-center/api/tasks'), {
      method: 'POST', headers, body: JSON.stringify({ workspaceId, executor: 'pi', instruction: 'inspect project' }),
    })
    expect(created.status).toBe(201)
    const taskId = (await created.json() as { task: { id: string } }).task.id
    expect(await (await fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie: session.cookie } })).json()).toMatchObject({
      tasks: [{ workspace: { id: workspaceId, path: projectPath } }],
    })

    for (const action of ['approve', 'run', 'cancel']) {
      expect((await fetch(endpoint(result.ctx, `/command-center/api/tasks/${taskId}/${action}`), { method: 'POST', headers, body: '{}' })).status).toBe(200)
    }
    expect(result.tasks.get(taskId)).toMatchObject({ state: 'cancelled' })

    const reviewedId = 'reviewed-task' as Task['id']
    result.tasks.set(reviewedId, {
      id: reviewedId, workspaceId: workspaceId as Task['workspaceId'], executor: 'pi', origin: 'dashboard', instruction: 'edit file', state: 'succeeded',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      copy: { root: '/private/task', original: projectPath, manifestSha256: 'c'.repeat(64), changes: { sha256: 'd'.repeat(64), count: 1, state: 'pending-review' } },
    })
    const review = await fetch(endpoint(result.ctx, `/command-center/api/tasks/${reviewedId}/changes`), { headers: { cookie: session.cookie } })
    expect(review.status).toBe(200)
    expect(await review.json()).toMatchObject({ sha256: 'd'.repeat(64), changes: [{ path: 'file.txt' }] })
    const applied = await fetch(endpoint(result.ctx, `/command-center/api/tasks/${reviewedId}/apply`), { method: 'POST', headers, body: JSON.stringify({ sha256: 'd'.repeat(64) }) })
    expect(applied.status).toBe(200)
    expect(result.tasks.get(reviewedId)?.copy?.changes?.state).toBe('applied')
  })

  it('rejects malformed, expired, and unauthorized requests without mutating tasks', async () => {
    const denied = await harness({}, (_request, response) => {
      const output = response as { writeHead: (status: number) => void; end: (body?: string) => void }
      output.writeHead(401)
      output.end('authentication required')
      return false
    })
    disposals.push(denied.dispose)
    expect((await fetch(endpoint(denied.ctx, '/command-center/api/session'))).status).toBe(401)

    const result = await harness()
    disposals.push(result.dispose)
    const session = await openSession(result.ctx)
    const headers = { cookie: session.cookie, 'x-dsh-csrf': session.csrf, 'content-type': 'application/json' }
    await expect(fetch(endpoint(result.ctx, '/command-center/api/missing'), { headers: { cookie: session.cookie } })).resolves.toMatchObject({ status: 403 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie: 'unrelated=value' } })).resolves.toMatchObject({ status: 401 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/missing'), { method: 'POST', headers, body: '{}' })).resolves.toMatchObject({ status: 404 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks/string-error/approve'), { method: 'POST', headers, body: '{}' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers, body: 'null' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/workspaces'), { method: 'POST', headers, body: '{}' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks'), { method: 'POST', headers, body: JSON.stringify({ executor: 'nope' }) })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks'), { method: 'POST', headers, body: '{' })).resolves.toMatchObject({ status: 400 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/tasks/missing/apply'), { method: 'POST', headers, body: JSON.stringify({ sha256: 'bad' }) })).resolves.toMatchObject({ status: 400 })

    const privateDashboard = result.ctx.taskDashboard as unknown as { sessions: Map<string, { csrf: string; expiresAt: number }> }
    privateDashboard.sessions.set('expired', { csrf: 'csrf', expiresAt: 0 })
    await expect(fetch(endpoint(result.ctx, '/command-center/api/state'), { headers: { cookie: 'dsh_command_center_session=expired' } })).resolves.toMatchObject({ status: 401 })
  })

  it('accepts a direct-message-only Discord configuration', async () => {
    vi.stubGlobal('WebSocket', undefined)
    const result = await harness({ discordToken: 'token', discordUserId: '12345678901234567' })
    disposals.push(result.dispose)

    const ctx = new Context()
    ctx.provide('webServer', { host: '127.0.0.1', register: () => () => undefined } as never)
    new TaskDashboard(ctx, { discordToken: 'token', discordUserId: '12345678901234567', discordPrefix: '!dm' })
    await ctx.fiber.dispose()
  })

  it('rejects incomplete or invalid Discord guild allowlists', async () => {
    const invalid: Config[] = [
      { discordToken: 'token' },
      { discordToken: 'token', discordUserId: '12345678901234567', discordGuildIds: ['12345678901234567'] },
      { discordToken: 'token', discordUserId: '12345678901234567', discordChannelIds: ['12345678901234567'] },
      { discordToken: 'token', discordUserId: 'bad', discordGuildIds: ['12345678901234567'], discordChannelIds: ['12345678901234567'] },
      { discordToken: 'token', discordUserId: '12345678901234567', discordGuildIds: ['bad'], discordChannelIds: ['12345678901234567'] },
      { discordToken: 'token', discordUserId: '12345678901234567', discordGuildIds: ['12345678901234567'], discordChannelIds: ['bad'] },
    ]
    for (const config of invalid) await expect(harness(config)).rejects.toThrow(/Discord|snowflake/u)
  })

  it('rejects a non-loopback web server before it registers routes', () => {
    const ctx = new Context()
    ctx.provide('webServer', { host: '0.0.0.0' } as never)
    expect(() => new TaskDashboard(ctx, {})).toThrow('127.0.0.1')
  })

  it('defends direct malformed requests', async () => {
    const result = await harness()
    disposals.push(result.dispose)
    const dashboard = result.ctx.taskDashboard as unknown as { api: (request: unknown, response: unknown) => Promise<void> }
    const statuses: number[] = []
    const response = { setHeader: () => undefined, writeHead: (status: number) => statuses.push(status), end: () => undefined }
    await dashboard.api({ headers: { host: 'example.test' }, [Symbol.asyncIterator]: async function* () { yield 'ignored' } }, response)
    await dashboard.api({ method: 'GET', headers: { host: '127.0.0.1' }, url: '/command-center/api/session' }, response)
    expect(statuses).toEqual([404, 200])
  })
})
