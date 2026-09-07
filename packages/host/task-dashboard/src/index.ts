/** Local authenticated API for the Software Factory browser surface. */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { TaskId, type TaskExecutor } from '@deepseek-ai/dsh-task-control'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-task-execution'
import { DiscordTaskIngress, type DiscordIngressConfig } from './discord.ts'

export { DiscordTaskIngress } from './discord.ts'
export type { DiscordIngressConfig } from './discord.ts'

const ROOT = '/command-center'
const API = `${ROOT}/api`
const SESSION = `${API}/session`
const SESSION_COOKIE = 'dsh_command_center_session'
const MAX_BODY_BYTES = 16 * 1024
const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** Local dashboard session lifetime configuration. */
export interface Config {
  /** Session lifetime in milliseconds before the browser must reload the dashboard. */
  readonly sessionTtlMs?: number
  /** Dedicated Discord bot token; omit every Discord field to disable Discord ingress. */
  readonly discordToken?: string
  /** Only Discord user permitted to issue commands. */
  readonly discordUserId?: string
  /** Exact server allowlist for guild messages; omit with discordChannelIds for DM-only ingress. */
  readonly discordGuildIds?: string[]
  /** Exact channel allowlist for guild messages; omit with discordGuildIds for DM-only ingress. */
  readonly discordChannelIds?: string[]
  /** Discord command prefix (default: `!cc`). */
  readonly discordPrefix?: string
}

interface Session {
  readonly csrf: string
  readonly expiresAt: number
}

interface BrowserIndexAuthorizer {
  authorizeIndex(request: IncomingMessage, response: ServerResponse): boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Local authenticated Software Factory API owner. */
    taskDashboard: TaskDashboard
  }
}

/**
 * Local Software Factory API. The Web app serves the shell for `/command-center`;
 * this host plugin keeps task authorization, session CSRF, and Discord ingress.
 */
export class TaskDashboard extends Service {
  static inject = ['webServer', 'taskControl', 'taskExecution', 'connection']
  static Config: z<Config> = z.object({
    sessionTtlMs: z.number().min(1).step(1).default(SESSION_TTL_MS),
    discordToken: z.string().min(1),
    discordUserId: z.string().min(1),
    discordGuildIds: z.array(z.string().min(1)),
    discordChannelIds: z.array(z.string().min(1)),
    discordPrefix: z.string().min(1),
  })

  private readonly sessions = new Map<string, Session>()
  private readonly sessionTtlMs: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'taskDashboard')
    this.sessionTtlMs = config.sessionTtlMs ?? SESSION_TTL_MS
    if (ctx.webServer.host !== '127.0.0.1') {
      throw new Error('Software Factory requires the web server to bind 127.0.0.1')
    }
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API, handler: async (req, res) => { await this.api(req, res) } }), 'taskDashboard.api')
    const discordConfig = resolveDiscordConfig(config)
    if (discordConfig !== undefined) {
      const discord = new DiscordTaskIngress(ctx, discordConfig)
      ctx.effect(() => {
        discord.start()
        return () => { discord.stop() }
      }, 'taskDashboard.discord')
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req)) {
      respond(res, 404)
      return
    }
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'GET' && path === SESSION) {
      this.openSession(req, res)
      return
    }
    const session = this.session(req)
    if (session === undefined) {
      respond(res, 401)
      return
    }
    try {
      if (req.method === 'GET' && path === `${API}/state`) {
        respondJson(res, 200, this.state())
        return
      }
      const reviewTaskId = reviewTaskIdFromPath(path)
      if (req.method === 'GET' && reviewTaskId !== undefined) {
        respondJson(res, 200, await this.ctx.taskExecution.review(reviewTaskId))
        return
      }
      if (req.method !== 'POST' || req.headers['x-dsh-csrf'] !== session.csrf) {
        respond(res, 403)
        return
      }
      const body = await json(req)
      if (path === `${API}/workspaces`) {
        await this.createWorkspace(body, res)
        return
      }
      if (path === `${API}/tasks`) {
        await this.createTask(body, res)
        return
      }
      const taskId = taskIdFromPath(path)
      if (taskId === undefined) {
        respond(res, 404)
        return
      }
      if (path.endsWith('/approve')) {
        respondJson(res, 200, { task: await this.ctx.taskControl.approve(taskId) })
        return
      }
      if (path.endsWith('/run')) {
        respondJson(res, 200, { task: await this.ctx.taskExecution.run(taskId) })
        return
      }
      if (path.endsWith('/apply')) {
        const value = object(body)
        if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error('exact change-set digest is required')
        respondJson(res, 200, { task: await this.ctx.taskExecution.apply(taskId, value.sha256) })
        return
      }
      respondJson(res, 200, { task: await this.ctx.taskExecution.cancel(taskId) })
    } catch (error) {
      respondJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private openSession(req: IncomingMessage, res: ServerResponse): void {
    const connection = this.ctx.get('connection') as BrowserIndexAuthorizer
    if (!connection.authorizeIndex(req, res)) return
    this.purge()
    const id = token()
    const csrf = token()
    this.sessions.set(id, { csrf, expiresAt: Date.now() + this.sessionTtlMs })
    res.setHeader('cache-control', 'no-store')
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=${API}; Max-Age=${Math.ceil(this.sessionTtlMs / 1000)}`)
    respondJson(res, 200, { csrf })
  }

  private state(): object {
    const workspaces = this.ctx.taskControl.listProjects()
    const byId = new Map(workspaces.map(workspace => [workspace.id, workspace]))
    return {
      workspaces: workspaces.map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path })),
      tasks: this.ctx.taskControl.list().map((task) => {
        const workspace = byId.get(task.workspaceId)
        return {
          ...task,
          ...(workspace === undefined ? {} : { workspace: { id: workspace.id, title: workspace.title, path: workspace.path } }),
        }
      }),
    }
  }

  private async createWorkspace(value: unknown, res: ServerResponse): Promise<void> {
    const body = object(value)
    if (typeof body.path !== 'string') throw new Error('workspace path is required')
    const workspace = await this.ctx.taskControl.registerProject(body.path)
    respondJson(res, 201, { workspace: { id: workspace.id, title: workspace.title, path: workspace.path } })
  }

  private async createTask(value: unknown, res: ServerResponse): Promise<void> {
    const body = object(value)
    if (!isExecutor(body.executor) || typeof body.workspaceId !== 'string' || typeof body.instruction !== 'string') {
      throw new Error('workspaceId, executor, and instruction are required')
    }
    const task = await this.ctx.taskControl.create({
      workspaceId: body.workspaceId as never,
      executor: body.executor,
      origin: 'dashboard',
      instruction: body.instruction,
    })
    respondJson(res, 201, { task })
  }

  private session(req: IncomingMessage): Session | undefined {
    this.purge()
    const id = cookie(req.headers.cookie, SESSION_COOKIE)
    return id === undefined ? undefined : this.sessions.get(id)
  }

  private purge(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id)
  }
}

function resolveDiscordConfig(config: Config): DiscordIngressConfig | undefined {
  const token = typeof config.discordToken === 'string' && config.discordToken !== '' ? config.discordToken : undefined
  const userId = typeof config.discordUserId === 'string' && config.discordUserId !== '' ? config.discordUserId : undefined
  const guildIds = config.discordGuildIds ?? []
  const channelIds = config.discordChannelIds ?? []
  const hasPrefix = typeof config.discordPrefix === 'string' && config.discordPrefix !== ''
  if (token === undefined && userId === undefined && guildIds.length === 0 && channelIds.length === 0 && !hasPrefix) return undefined
  if (token === undefined || userId === undefined || (guildIds.length > 0) !== (channelIds.length > 0)) {
    throw new Error('Discord command center requires a token, user, and matching non-empty server/channel allowlists for guild messages')
  }
  const snowflake = /^\d{17,20}$/u
  if (!snowflake.test(userId)
    || guildIds.some(value => !snowflake.test(value))
    || channelIds.some(value => !snowflake.test(value))) {
    throw new Error('Discord user, server, and channel allowlists must contain Discord snowflake IDs')
  }
  return {
    token,
    userId,
    guildIds,
    channelIds,
    prefix: config.discordPrefix ?? '!cc',
  }
}

function isExecutor(value: unknown): value is TaskExecutor {
  return value === 'pi' || value === 'codex' || value === 'openclaw'
}

function token(): string {
  return randomBytes(32).toString('base64url')
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cookie(header: string | undefined, name: string): string | undefined {
  return header?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
}

function isLoopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host?.split(':')[0]
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

function taskIdFromPath(path: string): ReturnType<typeof TaskId> | undefined {
  const match = /^\/command-center\/api\/tasks\/([^/]+)\/(?:approve|run|cancel|apply)$/u.exec(path)
  if (match === null || match[1] === undefined) return undefined
  return TaskId(decodeURIComponent(match[1]))
}

function reviewTaskIdFromPath(path: string): ReturnType<typeof TaskId> | undefined {
  const match = /^\/command-center\/api\/tasks\/([^/]+)\/changes$/u.exec(path)
  return match?.[1] === undefined ? undefined : TaskId(decodeURIComponent(match[1]))
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 16 KiB')
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new Error('request body must be JSON')
  }
}

function respond(res: ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  respond(res, status, JSON.stringify(value), 'application/json; charset=utf-8')
}

export default TaskDashboard
