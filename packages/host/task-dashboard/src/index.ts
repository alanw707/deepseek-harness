/** Loopback-only browser dashboard for command-center task control. */

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
  /** Exact server allowlist. */
  readonly discordGuildIds?: string[]
  /** Exact channel allowlist. */
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
    /** Local authenticated command-center dashboard route owner. */
    taskDashboard: TaskDashboard
  }
}

/**
 * Local command-center dashboard. It issues opaque HttpOnly browser sessions,
 * requires a per-page CSRF value for every mutation, and serves no route when
 * the Host is not bound to loopback.
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
      throw new Error('task dashboard requires the web server to bind 127.0.0.1')
    }
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROOT, handler: (req, res) => { this.page(req, res) } }), 'taskDashboard.page')
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API, handler: async (req, res) => { await this.api(req, res) } }), 'taskDashboard.api')
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'html', placement: 'body', html: chatNavigationHtml() })
    })
    const discordConfig = resolveDiscordConfig(config)
    if (discordConfig !== undefined) {
      const discord = new DiscordTaskIngress(ctx, discordConfig)
      ctx.effect(() => {
        discord.start()
        return () => { discord.stop() }
      }, 'taskDashboard.discord')
    }
  }

  private page(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET' || !isLoopbackHost(req)) {
      respond(res, 404)
      return
    }
    const connection = this.ctx.get('connection') as BrowserIndexAuthorizer
    if (!connection.authorizeIndex(req, res)) return
    this.purge()
    const id = token()
    const csrf = token()
    this.sessions.set(id, { csrf, expiresAt: Date.now() + this.sessionTtlMs })
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=${API}; Max-Age=${Math.ceil(this.sessionTtlMs / 1000)}`)
    respond(res, 200, pageHtml(csrf), 'text/html; charset=utf-8')
  }

  private async api(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackHost(req)) {
      respond(res, 404)
      return
    }
    const session = this.session(req)
    if (session === undefined) {
      respond(res, 401)
      return
    }
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
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
  const hasToken = typeof config.discordToken === 'string' && config.discordToken !== ''
  const hasUser = typeof config.discordUserId === 'string' && config.discordUserId !== ''
  const hasGuilds = Array.isArray(config.discordGuildIds) && config.discordGuildIds.length > 0
  const hasChannels = Array.isArray(config.discordChannelIds) && config.discordChannelIds.length > 0
  const hasPrefix = typeof config.discordPrefix === 'string' && config.discordPrefix !== ''
  if (!hasToken && !hasUser && !hasGuilds && !hasChannels && !hasPrefix) return undefined
  if (!hasToken || !hasUser || !hasGuilds || !hasChannels) {
    throw new Error('Discord command center requires a token plus non-empty user, server, and channel allowlists')
  }
  const snowflake = /^\d{17,20}$/u
  if (!snowflake.test(config.discordUserId)
    || config.discordGuildIds.some(value => !snowflake.test(value))
    || config.discordChannelIds.some(value => !snowflake.test(value))) {
    throw new Error('Discord user, server, and channel allowlists must contain Discord snowflake IDs')
  }
  return {
    token: config.discordToken,
    userId: config.discordUserId,
    guildIds: config.discordGuildIds,
    channelIds: config.discordChannelIds,
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

function chatNavigationHtml(): string {
  return `<style>
#dsh-command-center-nav{position:fixed;top:12px;right:16px;z-index:2147483000;display:flex;align-items:center;gap:3px;padding:3px;border:1px solid #e5e8ee;border-radius:10px;background:#ffffffee;box-shadow:0 6px 18px #1a223014;font:600 12px/1.2 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;backdrop-filter:blur(8px)}
#dsh-command-center-nav a{display:inline-flex;align-items:center;min-height:28px;padding:0 10px;border-radius:7px;color:#697386;text-decoration:none}#dsh-command-center-nav a:hover{background:#f2f4f8;color:#202938}#dsh-command-center-nav a:focus-visible{outline:2px solid #6d8ff5;outline-offset:2px}#dsh-command-center-nav a[aria-current=page]{background:#eef2ff;color:#405ac7}@media(max-width:600px){#dsh-command-center-nav{top:8px;right:8px}}
</style><nav id="dsh-command-center-nav" aria-label="Application navigation"><a href="/" aria-current="page">Chat</a><a href="/command-center">Tasks</a></nav>`
}

function pageHtml(csrf: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tasks · DSH</title>
<style>
:root{color-scheme:light;--bg:#f6f7fa;--surface:#fff;--surface-muted:#fbfcfe;--line:#e3e7ef;--line-strong:#d4dbe7;--text:#202938;--muted:#6b7485;--subtle:#8a94a5;--accent:#516bd6;--accent-soft:#eef2ff;--accent-ink:#fff;--good:#16845a;--good-soft:#e9f8f0;--warn:#9a6500;--warn-soft:#fff7df;--bad:#b53c3c;--bad-soft:#fff0f0;--info:#3f70b5;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text)}body::selection{background:#dce4ff;color:#202938}button,input,select,textarea{font:inherit}a{color:inherit}button,input,select,textarea{border:1px solid var(--line-strong);border-radius:9px;background:var(--surface);color:var(--text)}button{cursor:pointer;font-weight:650;padding:.68rem .92rem}button:hover:not(:disabled){border-color:#b5c1d4;background:#f8faff}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #a9b9f8;outline-offset:2px}button:disabled{cursor:not-allowed;opacity:.5}input,select,textarea{padding:.72rem .8rem;width:100%}textarea{min-height:8rem;resize:vertical}::placeholder{color:#a1aab8}.topbar{border-bottom:1px solid var(--line);background:#fff}.topbar-inner{display:flex;align-items:center;gap:1.4rem;width:min(1120px,calc(100% - 40px));min-height:68px;margin:auto}.wordmark{display:inline-flex;align-items:baseline;gap:.42rem;color:var(--text);font-size:1.05rem;font-weight:760;letter-spacing:-.02em;text-decoration:none;white-space:nowrap}.wordmark span{color:var(--subtle);font-size:.75rem;font-weight:550;letter-spacing:.01em}.primary-nav{display:flex;gap:.2rem;margin-left:.8rem}.primary-nav a{padding:.45rem .7rem;border-radius:7px;color:var(--muted);font-size:.88rem;font-weight:650;text-decoration:none}.primary-nav a:hover{background:#f4f6fa;color:var(--text)}.primary-nav a[aria-current=page]{background:var(--accent-soft);color:#405ac7}.local{margin-left:auto;padding:.35rem .62rem;border:1px solid #cde9db;border-radius:999px;background:#f5fcf8;color:var(--good);font-size:.75rem;font-weight:700;white-space:nowrap}.local::before{display:inline-block;width:.45rem;height:.45rem;margin-right:.4rem;border-radius:50%;background:#38af78;content:""}
main{width:min(1120px,calc(100% - 40px));margin:auto;padding:2.6rem 0 5rem}.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(300px,.9fr);gap:2rem;align-items:end;margin-bottom:2.1rem}.hero h1{max-width:18ch;margin:0 0 .8rem;font-size:2.2rem;line-height:1.08;letter-spacing:-.035em}.hero p{max-width:62ch;margin:0;color:var(--muted);font-size:1rem}.path-card{padding:1.05rem 1.15rem;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.path-card strong{display:block;margin-bottom:.75rem;font-size:.78rem;letter-spacing:.02em}.path{display:grid;grid-template-columns:repeat(4,1fr);gap:.4rem}.path-step{display:grid;gap:.42rem;color:var(--subtle);font-size:.72rem;line-height:1.2}.path-step::before{height:3px;border-radius:3px;background:var(--line-strong);content:""}.path-step.current{color:var(--accent);font-weight:700}.path-step.current::before{background:var(--accent)}.path-step.done{color:var(--good)}.path-step.done::before{background:#67c796}.notice{display:flex;align-items:center;gap:.8rem;min-height:0;margin:0 0 1rem;padding:.75rem .9rem;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--bad);font-size:.88rem}.notice[hidden]{display:none}.notice button{margin-left:auto;padding:.42rem .65rem;border-color:#efc4c4;color:var(--bad);font-size:.8rem}.workspace-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.48fr);gap:1rem;align-items:start}.panel,.secondary-column details{border:1px solid var(--line);border-radius:14px;background:var(--surface)}.panel{padding:1.35rem 1.45rem}.panel h2{margin:0 0 .3rem;font-size:1.12rem;letter-spacing:-.015em}.panel-intro{margin:0 0 1.35rem;color:var(--muted);font-size:.9rem}.field{display:grid;gap:.4rem;margin-bottom:1rem}.field label{font-size:.8rem;font-weight:700}.field-help{margin:-.7rem 0 1rem;color:var(--subtle);font-size:.78rem}.field-row{display:grid;grid-template-columns:minmax(0,1fr) 12rem;gap:.8rem}.form-footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:1.2rem}.form-note{color:var(--muted);font-size:.78rem}.primary{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}.primary:hover:not(:disabled){border-color:#405ac7;background:#405ac7}.secondary-column{display:grid;gap:.8rem}.secondary-column details{padding:0;overflow:hidden}.secondary-column summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.05rem;list-style:none;cursor:pointer;font-size:.86rem;font-weight:700}.secondary-column summary::-webkit-details-marker{display:none}.secondary-column summary::after{color:var(--subtle);content:"+";font-size:1.1rem;font-weight:400}.secondary-column details[open] summary::after{content:"−"}.summary-copy{display:grid;gap:.15rem}.summary-copy small{color:var(--muted);font-size:.75rem;font-weight:450}.secondary-body{padding:0 1.05rem 1.1rem;border-top:1px solid var(--line)}.secondary-body p{margin:.95rem 0;color:var(--muted);font-size:.8rem}.setup-form{display:grid;gap:.7rem}.setup-form button{justify-self:start}.history-count{color:var(--subtle);font-size:.76rem;font-weight:500}.empty-secondary{margin:0;padding:.95rem 0;color:var(--muted);font-size:.8rem}.active-section{margin-top:2.5rem}.section-head{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin-bottom:.65rem;padding-bottom:.75rem;border-bottom:1px solid var(--line)}.section-head h2{margin:0;font-size:1.2rem;letter-spacing:-.02em}.section-head p{margin:0;color:var(--muted);font-size:.82rem}.task-list{display:grid;gap:.8rem}.task-card{padding:1.25rem 1.35rem;border:1px solid var(--line);border-radius:14px;background:var(--surface)}.task-card[data-state=pending-approval],.task-card[data-attention=true]{border-color:#cfd8fa}.task-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem}.task-ident{display:flex;align-items:center;gap:.45rem;min-width:0;flex-wrap:wrap}.project{color:var(--muted);font-size:.8rem;font-weight:650}.executor{color:var(--subtle);font-size:.73rem;font-weight:750;letter-spacing:.04em;text-transform:uppercase}.status{padding:.27rem .58rem;border-radius:999px;background:#f0f2f6;color:var(--muted);font-size:.72rem;font-weight:750;white-space:nowrap}.status-review{background:var(--warn-soft);color:var(--warn)}.status-info{background:#eef4fb;color:var(--info)}.status-running{background:var(--accent-soft);color:#405ac7}.status-success{background:var(--good-soft);color:var(--good)}.status-error{background:var(--bad-soft);color:var(--bad)}.task-time{flex:none;color:var(--subtle);font-size:.74rem}.task-instruction{max-width:76ch;margin:.9rem 0 1.15rem;font-size:1rem;line-height:1.48;overflow-wrap:anywhere}.task-progress{display:grid;grid-template-columns:repeat(4,1fr);gap:.45rem;margin:0 0 1.1rem;padding:0;list-style:none}.task-progress li{display:grid;gap:.35rem;color:var(--subtle);font-size:.7rem;line-height:1.2}.task-progress li::before{height:3px;border-radius:3px;background:var(--line-strong);content:""}.task-progress li.current{color:var(--accent);font-weight:750}.task-progress li.current::before{background:var(--accent)}.task-progress li.done{color:var(--good)}.task-progress li.done::before{background:#67c796}.next-action{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.9rem;padding:1rem 1.05rem;border-radius:10px;background:var(--surface-muted)}.next-copy{min-width:0}.next-label{display:block;margin-bottom:.2rem;color:var(--subtle);font-size:.7rem;font-weight:750;letter-spacing:.06em;text-transform:uppercase}.next-title{display:block;font-size:.94rem;font-weight:750}.next-description{margin:.25rem 0 0;color:var(--muted);font-size:.8rem}.actions{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap}.danger{border-color:#efc4c4;color:var(--bad)}.danger:hover:not(:disabled){border-color:#d98f8f;background:var(--bad-soft)}.output-viewer,.change-review{margin-top:.8rem;border-top:1px solid var(--line);padding-top:.8rem}.output-viewer summary{display:flex;align-items:center;justify-content:space-between;gap:1rem;cursor:pointer;color:var(--text);font-size:.84rem;font-weight:700;list-style:none}.output-viewer summary::-webkit-details-marker{display:none}.output-viewer summary::after{color:var(--subtle);content:"View";font-size:.75rem;font-weight:550}.output-viewer[open] summary::after{content:"Hide"}.viewer-toolbar{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin:.65rem 0 .45rem;color:var(--muted);font-size:.75rem}.output-scroll,.diff-scroll{display:block;width:100%;max-height:20rem;margin:0;padding:.9rem;border:1px solid var(--line);border-radius:8px;background:#f8f9fc;color:#3d4655;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;word-break:break-word;overscroll-behavior:contain;scrollbar-gutter:stable both-edges;-webkit-overflow-scrolling:touch;scrollbar-color:#b5bfd0 #edf0f5}.output-scroll:focus-visible,.diff-scroll:focus-visible{outline:3px solid #a9b9f8;outline-offset:2px}.change-review h3{margin:0;font-size:.93rem}.change-review>p{margin:.3rem 0;color:var(--muted);font-size:.8rem}.digest-row{display:flex;align-items:center;gap:.5rem;margin:.75rem 0;min-width:0;color:var(--muted);font-size:.75rem}.digest-row code{min-width:0;padding:.28rem .4rem;border-radius:5px;background:#f1f3f7;color:#586275;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.change-item{margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--line)}.change-item h4{margin:0 0 .55rem;font-size:.8rem;overflow-wrap:anywhere}.diff-grid{display:grid;grid-template-columns:1fr 1fr;gap:.65rem}.diff-pane{min-width:0}.diff-label{margin-bottom:.3rem;color:var(--subtle);font-size:.72rem;font-weight:700}.diff-scroll{max-height:14rem;background:#fbfcfe}.change-apply{margin-top:.8rem}.change-detail{margin:.65rem 0 0;color:var(--bad);font-size:.8rem}.empty{margin:0;padding:1.4rem 0;color:var(--muted);font-size:.88rem}.task-meta{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-top:.85rem;color:var(--subtle);font-size:.75rem}.task-id{font:11px ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.history-list .task-card{padding:1rem 1.1rem}.history-list .task-progress,.history-list .next-action{display:none}.history-list .task-instruction{margin:.65rem 0;font-size:.9rem}.history-list .task-card .output-viewer,.history-list .task-card .change-review{margin-top:.65rem}.history-list .task-card .task-heading{align-items:center}
@media(max-width:820px){.hero,.workspace-grid{grid-template-columns:1fr}.hero{gap:1.25rem}.hero h1{max-width:24ch}.secondary-column{grid-template-columns:1fr 1fr}.active-section{margin-top:2rem}}
@media(max-width:600px){.topbar-inner,main{width:min(100% - 24px,1120px)}.topbar-inner{gap:.7rem;min-height:60px}.wordmark span{display:none}.primary-nav{margin-left:0}.local{font-size:0}.local::before{margin:0}.hero{margin-bottom:1.5rem}.hero h1{font-size:1.85rem}.path-card{padding:.85rem}.field-row,.secondary-column{grid-template-columns:1fr}.form-footer,.next-action,.task-heading{align-items:stretch;flex-direction:column}.form-footer button,.next-action button{width:100%}.task-card,.panel{padding:1.05rem}.task-progress{gap:.25rem}.task-progress li{font-size:.64rem}.diff-grid{grid-template-columns:1fr}.task-time{order:-1}}
</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner"><a class="wordmark" href="/">DSH <span>software factory</span></a><nav class="primary-nav" aria-label="Primary navigation"><a href="/">Chat</a><a href="/command-center" aria-current="page">Tasks</a></nav><span class="local">Local only</span></div></header>
<main>
<section class="hero"><div><h1>Move work forward. Keep the final say.</h1><p>Tasks run in a private project snapshot. You decide when work starts, review the exact files it changed, and apply those changes to the original project.</p></div><div class="path-card"><strong>Every task follows the same path</strong><div class="path"><span class="path-step current">New task</span><span class="path-step">Review &amp; start</span><span class="path-step">Review changes</span><span class="path-step">Apply</span></div></div></section>
<div id="notice" class="notice" role="alert" aria-live="assertive" hidden><span id="notice-message"></span><button id="reload" type="button" hidden>Reload dashboard</button></div>
<div class="workspace-grid"><section class="panel"><h2>New task</h2><p class="panel-intro">Choose where the work belongs, pick an executor, and describe one bounded outcome. Creating a task does not start it.</p><form id="task"><div class="field-row"><div class="field"><label for="project">Project</label><select id="project" name="workspaceId" required><option value="" selected disabled>Choose a project</option></select></div><div class="field"><label for="executor">Executor</label><select id="executor" name="executor"><option value="pi">Pi</option><option value="codex">Codex</option><option value="openclaw">OpenClaw</option></select></div></div><p id="executor-help" class="field-help">Pi works in an isolated copy and returns proposed file changes for your review.</p><div class="field"><label for="instruction">What should it do?</label><textarea id="instruction" name="instruction" required placeholder="Example: Update README.md so the Status line says exactly “Ready for review.” Make no other changes."></textarea></div><div class="form-footer"><span id="task-form-note" class="form-note">Nothing runs until you approve the start.</span><button id="task-submit" class="primary" type="submit">Continue to review</button></div></form></section>
<aside class="secondary-column"><details id="project-setup"><summary><span class="summary-copy"><span>Project setup</span><small>Approve folders before agents can use them.</small></span></summary><div class="secondary-body"><p>Register an absolute WSL folder once. The original stays protected while an executor works.</p><form id="workspace" class="setup-form"><div class="field"><label for="project-path">Absolute project path</label><input id="project-path" name="path" placeholder="/home/user/projects/example" autocomplete="off" required></div><button type="submit">Add project</button></form></div></details><details id="history"><summary><span class="summary-copy"><span>Task history <span id="history-summary" class="history-count"></span></span><small>Completed and closed work stays here.</small></span></summary><div class="secondary-body"><div id="history-tasks" class="task-list history-list"></div></div></details></aside></div>
<section class="active-section"><div class="section-head"><div><h2>Tasks needing your attention</h2><p>Start waiting tasks, cancel active work, and review proposed changes here.</p></div><p id="summary" aria-live="polite"></p></div><div id="active-tasks" class="task-list"></div></section>
</main>
<script>
const csrf=${JSON.stringify(csrf)},api='${API}',notice=document.querySelector('#notice'),noticeMessage=document.querySelector('#notice-message'),reload=document.querySelector('#reload'),taskForm=document.querySelector('#task'),taskButton=document.querySelector('#task-submit'),workspaceForm=document.querySelector('#workspace'),projectSelect=document.querySelector('#project'),executorSelect=document.querySelector('#executor'),executorHelp=document.querySelector('#executor-help'),projectSetup=document.querySelector('#project-setup'),history=document.querySelector('#history'),historySummary=document.querySelector('#history-summary'),summary=document.querySelector('#summary'),activeTasks=document.querySelector('#active-tasks'),historyTasks=document.querySelector('#history-tasks'),reviews=new Map()
let sessionExpired=false,focusTaskId,renderPromise
const executorDescriptions={pi:'Pi works in an isolated copy and returns proposed file changes for your review.',codex:'Codex works in an isolated copy and returns proposed file changes for your review.',openclaw:'OpenClaw works in an isolated Docker copy and returns proposed file changes for your review.'}
const call=async(path,options={})=>{const response=await fetch(api+path,{...options,headers:{...(options.method?{'content-type':'application/json'}:{}),'x-dsh-csrf':csrf,...(options.headers||{})}});if(!response.ok){const body=await response.text();if(response.status===401){sessionExpired=true;throw Error('Your dashboard session expired. Reload the page to reconnect.')}let message='';if(body!==''){try{const parsed=JSON.parse(body);if(parsed&&typeof parsed.error==='string')message=parsed.error;else message=body}catch{message=body}}throw Error(message||'Request failed (HTTP '+String(response.status)+').')}const body=await response.text();return body===''?{}:JSON.parse(body)}
const element=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
const showError=error=>{notice.hidden=false;noticeMessage.textContent=error instanceof Error?error.message:String(error);reload.hidden=!sessionExpired}
const clearNotice=()=>{notice.hidden=true;noticeMessage.textContent='';reload.hidden=true}
reload.onclick=()=>{location.reload()}
executorSelect.onchange=()=>{executorHelp.textContent=executorDescriptions[executorSelect.value]||executorDescriptions.pi}
const formatExecutor=value=>value[0].toUpperCase()+value.slice(1)
const formatState=value=>value.replaceAll('-',' ')
const referenceOf=task=>task.copy&&task.copy.changes
const hasPendingChanges=task=>{const reference=referenceOf(task);return reference!==undefined&&reference.state!=='no-change'&&reference.state!=='applied'}
const needsAttention=task=>['pending-approval','queued','running','cancelling'].includes(task.state)||hasPendingChanges(task)
const statusOf=task=>{const reference=referenceOf(task);if(task.state==='pending-approval')return {label:'Needs review',tone:'review'};if(task.state==='queued')return {label:'Ready to start',tone:'review'};if(task.state==='running')return {label:'Running',tone:'running'};if(task.state==='cancelling')return {label:'Stopping',tone:'running'};if(task.state==='failed')return {label:'Run failed',tone:'error'};if(task.state==='cancelled')return {label:'Cancelled',tone:'error'};if(task.state==='interrupted')return {label:'Interrupted',tone:'error'};if(reference?.state==='no-change')return {label:'No changes',tone:'info'};if(reference?.state==='pending-review')return {label:'Changes ready',tone:'review'};if(reference?.state==='applying')return {label:'Applying changes',tone:'running'};if(reference?.state==='apply-failed')return {label:'Apply failed',tone:'error'};if(reference?.state==='apply-interrupted')return {label:'Apply interrupted',tone:'error'};if(reference?.state==='applied')return {label:'Applied',tone:'success'};return {label:'Completed',tone:'success'}}
const stageOf=task=>{const reference=referenceOf(task);if(task.state==='pending-approval'||task.state==='queued'||task.state==='running'||task.state==='cancelling')return 1;if(reference?.state==='pending-review')return 2;if(reference!==undefined)return 3;return 3}
const progressOf=task=>{const current=stageOf(task),tone=statusOf(task).tone,finished=(tone==='success'||tone==='info')&&current===3,progress=element('ol','task-progress'),labels=['New task','Review & start','Review changes','Apply'];labels.forEach((label,index)=>{const item=element('li',(finished||index<current?'done ':index===current?'current ':'')+((statusOf(task).tone==='error'&&index===current)?'current':'') ,label);progress.append(item)});return progress}
const actionButton=(label,className,handler)=>{const button=element('button',className,label);button.type='button';button.onclick=async()=>{button.disabled=true;clearNotice();try{await handler(button)}catch(error){showError(error);button.disabled=false}};return button}
const postOptions={method:'POST',body:'{}'}
const startTask=async(task,button)=>{if(task.state==='pending-approval')await call('/tasks/'+encodeURIComponent(task.id)+'/approve',postOptions);await call('/tasks/'+encodeURIComponent(task.id)+'/run',postOptions);await render()}
const cancelTask=async(task)=>{await call('/tasks/'+encodeURIComponent(task.id)+'/cancel',postOptions);await render()}
const nextAction=task=>{const wrapper=element('div','next-action'),copy=element('div','next-copy'),label=element('span','next-label','Next action'),title=element('strong','next-title'),description=element('p','next-description');copy.append(label,title,description);const actions=element('div','actions');const executor=formatExecutor(task.executor);if(task.state==='pending-approval'){title.textContent='Review the request, then start '+executor;description.textContent='The executor will work in a private snapshot. Your original project will not change.';actions.append(actionButton('Approve & start '+executor,'primary',button=>startTask(task,button)),actionButton('Cancel task','danger',()=>cancelTask(task)))}else if(task.state==='queued'){title.textContent='Start '+executor;description.textContent='This task is approved and waiting for its private run to begin.';actions.append(actionButton('Start task','primary',()=>startTask(task)),actionButton('Cancel task','danger',()=>cancelTask(task)))}else if(task.state==='running'){title.textContent=executor+' is working';description.textContent='The original project remains unchanged while the private snapshot is updated.';actions.append(actionButton('Cancel task','danger',()=>cancelTask(task)))}else if(task.state==='cancelling'){title.textContent='Waiting for '+executor+' to stop';description.textContent='The process is being terminated. This page will update when it has exited.'}else if(referenceOf(task)?.state==='pending-review'){title.textContent='Review the proposed file changes';description.textContent='Inspect the exact before-and-after files. Apply them only when they look right.'}else if(referenceOf(task)?.state==='applying'){title.textContent='Applying your approved changes';description.textContent='The approved digest is being applied to the original project.'}else if(referenceOf(task)?.state==='apply-failed'||referenceOf(task)?.state==='apply-interrupted'){title.textContent='Resolve the apply outcome';description.textContent=referenceOf(task)?.detail||'The original project was not reported as fully updated.'}else if(referenceOf(task)?.state==='no-change'){title.textContent='No changes to apply';description.textContent='The executor completed without changing the private project.'}else if(referenceOf(task)?.state==='applied'){title.textContent='Changes applied to the original project';description.textContent='The exact reviewed change set is complete.'}else if(task.state==='succeeded'){title.textContent='Task complete';description.textContent='The executor finished without proposing file changes.'}else{title.textContent='Run ended';description.textContent='Start a new task when you are ready to try again.'}wrapper.append(copy,actions);return wrapper}
const sideText=(side)=>{if(!side)return 'Not present';if(side.type==='directory')return 'Directory · mode '+side.mode.toString(8);return side.text===undefined?'':side.text}
const sideView=(side,label,key)=>{const node=element('div','diff-pane'),title=element('div','diff-label',''+label);const pre=element('pre','diff-scroll',sideText(side));pre.tabIndex=0;pre.dataset.preserveScroll=key;node.append(title,pre);return node}
const changeReview=(task,reference)=>{const section=element('section','change-review'),heading=element('h3','', 'Review changes before applying'),intro=element('p','',reference.count+' staged change'+(reference.count===1?'':'s')+' · the original project is still unchanged.'),digest=element('div','digest-row','Exact digest:'),code=element('code','',reference.sha256);digest.append(code);section.append(heading,intro,digest);if(reference.detail)section.append(element('p','change-detail',reference.detail));const review=reviews.get(task.id);if(!review&&reference.state==='pending-review'){section.append(actionButton('Review exact changes','',async button=>{button.disabled=true;reviews.set(task.id,await call('/tasks/'+encodeURIComponent(task.id)+'/changes'));await render()}));return section}if(review){review.changes.forEach((change,index)=>{const item=element('article','change-item'),title=element('h4','',change.kind.toUpperCase()+' · '+change.path),grid=element('div','diff-grid');grid.append(sideView(change.before,'Before',task.id+'-before-'+String(index)),sideView(change.after,'After',task.id+'-after-'+String(index)));item.append(title,grid);section.append(item)});if(reference.state==='pending-review'&&review.sha256===reference.sha256)section.append(actionButton('Apply these exact changes','primary change-apply',async button=>{button.disabled=true;await call('/tasks/'+encodeURIComponent(task.id)+'/apply',{method:'POST',body:JSON.stringify({sha256:review.sha256})});await render()}))}return section}
const outputView=task=>{const details=element('details','output-viewer'),summary=element('summary','',task.state==='succeeded'?'Run output':'Task details'),toolbar=element('div','viewer-toolbar','Output from '+formatExecutor(task.executor)),pre=element('pre','output-scroll',task.detail||'');details.id='task-output-'+task.id;pre.tabIndex=0;pre.setAttribute('aria-label','Scrollable output from '+formatExecutor(task.executor));pre.dataset.preserveScroll='output-'+task.id;details.append(summary,toolbar,pre);return details}
const taskFingerprint=task=>JSON.stringify({id:task.id,state:task.state,updatedAt:task.updatedAt,instruction:task.instruction,detail:task.detail,reference:referenceOf(task),review:reviews.get(task.id)?.sha256})
const preserveScrollableState=(oldNode,newNode)=>{for(const oldScroll of oldNode.querySelectorAll('[data-preserve-scroll]')){const key=oldScroll.dataset.preserveScroll;if(!key)continue;const newScroll=[...newNode.querySelectorAll('[data-preserve-scroll]')].find(node=>node.dataset.preserveScroll===key);if(newScroll){newScroll.scrollTop=oldScroll.scrollTop;newScroll.scrollLeft=oldScroll.scrollLeft}}for(const oldDetails of oldNode.querySelectorAll('details')){if(!oldDetails.id)continue;const newDetails=[...newNode.querySelectorAll('details')].find(node=>node.id===oldDetails.id);if(newDetails)newDetails.open=oldDetails.open}}
const taskView=task=>{const article=element('article','task-card');article.dataset.taskId=task.id;article.dataset.state=task.state;article.dataset.attention=String(needsAttention(task));article.dataset.fingerprint=taskFingerprint(task);const head=element('div','task-heading'),ident=element('div','task-ident'),project=element('span','project',task.workspace?task.workspace.title:task.workspaceId),executor=element('span','executor',formatExecutor(task.executor)),status=statusOf(task),state=element('span','status status-'+status.tone,status.label),time=element('time','task-time',new Date(task.updatedAt).toLocaleString());project.title=task.workspace?task.workspace.path:task.workspaceId;time.dateTime=task.updatedAt;ident.append(project,executor,state);head.append(ident,time);article.append(head,element('p','task-instruction',task.instruction),progressOf(task),nextAction(task));if(task.detail)article.append(outputView(task));const reference=referenceOf(task);if(reference)article.append(changeReview(task,reference));const meta=element('div','task-meta'),id=element('span','task-id',task.id);id.title=task.id;meta.append(id);article.append(meta);return article}
const renderTaskList=(target,tasks,emptyText)=>{if(tasks.length===0){if(!target.querySelector('.empty'))target.replaceChildren(element('p','empty',emptyText));return}for(const child of [...target.children])if(!child.dataset.taskId)child.remove();const existing=new Map([...target.querySelectorAll('[data-task-id]')].map(node=>[node.dataset.taskId,node]));const desired=[];for(const task of tasks){let node=existing.get(task.id);const fingerprint=taskFingerprint(task);if(!node||node.dataset.fingerprint!==fingerprint){const next=taskView(task);if(node)preserveScrollableState(node,next);node=next}node.dataset.fingerprint=fingerprint;desired.push(node)}desired.forEach((node,index)=>{if(target.children[index]!==node)target.insertBefore(node,target.children[index]??null)});for(const child of [...target.children])if(!desired.includes(child))child.remove()}
const render=()=>{if(sessionExpired)return Promise.resolve();if(renderPromise)return renderPromise;renderPromise=(async()=>{try{const state=await call('/state'),selected=projectSelect.value;projectSelect.replaceChildren(new Option('Choose a project',''));for(const workspace of state.workspaces)projectSelect.append(new Option(workspace.title,workspace.id));if(state.workspaces.some(workspace=>workspace.id===selected))projectSelect.value=selected;else projectSelect.value='';const hasProjects=state.workspaces.length>0;taskButton.disabled=!hasProjects;projectSelect.disabled=!hasProjects;taskForm.querySelector('#instruction').disabled=!hasProjects;document.querySelector('#task-form-note').textContent=hasProjects?'Nothing runs until you approve the start.':'Add a project in Project setup before creating a task.';projectSetup.open=!hasProjects;const active=state.tasks.filter(needsAttention),historical=state.tasks.filter(task=>!needsAttention(task));summary.textContent=state.tasks.length+' task'+(state.tasks.length===1?'':'s');history.hidden=historical.length===0;historySummary.textContent=historical.length===0?'':'· '+String(historical.length);renderTaskList(activeTasks,active,'No tasks need your attention. Create a task when you are ready.');renderTaskList(historyTasks,historical,'No completed tasks yet.');if(focusTaskId){const target=[...document.querySelectorAll('[data-task-id]')].find(node=>node.dataset.taskId===focusTaskId);if(target)target.scrollIntoView({block:'center',behavior:'smooth'});focusTaskId=undefined}}finally{renderPromise=undefined}})();return renderPromise}
workspaceForm.onsubmit=async event=>{event.preventDefault();const button=workspaceForm.querySelector('button');button.disabled=true;clearNotice();try{const data=new FormData(workspaceForm);await call('/workspaces',{method:'POST',body:JSON.stringify(Object.fromEntries(data))});workspaceForm.reset();await render()}catch(error){showError(error)}finally{button.disabled=false}}
taskForm.onsubmit=async event=>{event.preventDefault();taskButton.disabled=true;clearNotice();try{const data=new FormData(taskForm);const result=await call('/tasks',{method:'POST',body:JSON.stringify(Object.fromEntries(data))});taskForm.reset();executorSelect.value='pi';executorHelp.textContent=executorDescriptions.pi;focusTaskId=result.task.id;await render()}catch(error){showError(error)}finally{taskButton.disabled=false}}
render().catch(showError);setInterval(()=>{void render()},1000)
</script>
</body>
</html>`
}

export default TaskDashboard
