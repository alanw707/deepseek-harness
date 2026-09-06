/** Allowlisted Discord command and terminal-notification ingress. */

import type { Context } from '@deepseek-ai/cordis'
import { isTerminalTaskState, TaskId, type Task, type TaskExecutor } from '@deepseek-ai/dsh-task-control'
import type {} from '@deepseek-ai/dsh-task-execution'

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'
const API_URL = 'https://discord.com/api/v10'
const INTENTS = 1 | (1 << 9) | (1 << 15)
const MAX_MESSAGE_LENGTH = 1900

/** Dedicated Discord bot and exact command-source allowlists. */
export interface DiscordIngressConfig {
  /** Dedicated Discord bot token. */
  readonly token: string
  /** Only Discord user permitted to issue commands. */
  readonly userId: string
  /** Servers in which commands are accepted. */
  readonly guildIds: readonly string[]
  /** Channels in which commands are accepted and outcomes are reported. */
  readonly channelIds: readonly string[]
  /** Command prefix. */
  readonly prefix: string
}

interface DiscordMessage {
  readonly id: string
  readonly channel_id: string
  readonly guild_id: string
  readonly content: string
  readonly author: { readonly id: string; readonly bot?: boolean }
}

interface GatewayPayload {
  readonly op: number
  readonly d?: unknown
  readonly s?: number | null
  readonly t?: string | null
}

/**
 * Owns one dedicated Discord Gateway connection and authorized command flow.
 * The dashboard remains the only approval and dispatch surface.
 */
export class DiscordTaskIngress {
  private socket: WebSocket | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private reconnect: NodeJS.Timeout | undefined
  private notifyTimer: NodeJS.Timeout | undefined
  private sequence: number | null = null
  private heartbeatAcknowledged = true
  private stopped = true
  private notifying = false
  private readonly guildIds: ReadonlySet<string>
  private readonly channelIds: ReadonlySet<string>

  /**
   * @param ctx - Command-center services used by Discord commands.
   * @param config - Dedicated bot credentials and source allowlists.
   */
  constructor(private readonly ctx: Context, private readonly config: DiscordIngressConfig) {
    this.guildIds = new Set(config.guildIds)
    this.channelIds = new Set(config.channelIds)
  }

  /** Start Gateway ingress and durable terminal-outcome delivery. */
  start(): void {
    this.stopped = false
    this.connect()
    this.notifyTimer = setInterval(() => { void this.notifyTerminalTasks().catch(reportDiscordError) }, 1000)
  }

  /** Stop reconnects, heartbeats, notifications, and the Gateway socket. */
  stop(): void {
    this.stopped = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.reconnect !== undefined) clearTimeout(this.reconnect)
    if (this.notifyTimer !== undefined) clearInterval(this.notifyTimer)
    this.socket?.close(1000, 'command center stopping')
    this.socket = undefined
  }

  /**
   * Process one Gateway message after runtime field validation.
   * @param value - Untrusted MESSAGE_CREATE payload.
   */
  async handle(value: unknown): Promise<void> {
    const message = discordMessage(value)
    if (message === undefined || !this.authorized(message)) return
    const content = message.content.trim()
    if (!content.startsWith(this.config.prefix)) return
    const command = content.slice(this.config.prefix.length).trim()
    try {
      await this.command(message, command)
    } catch (error) {
      await this.send(message.channel_id, `Request rejected: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private authorized(message: DiscordMessage): boolean {
    return message.author.bot !== true
      && message.author.id === this.config.userId
      && this.guildIds.has(message.guild_id)
      && this.channelIds.has(message.channel_id)
  }

  private async command(message: DiscordMessage, command: string): Promise<void> {
    if (command === 'help') {
      await this.send(message.channel_id, `${this.config.prefix} projects | run <project-id> <pi|codex|openclaw> <task> | status [task-id] | cancel <task-id>`)
      return
    }
    if (command === 'projects') {
      const projects = this.ctx.taskControl.listProjects()
      await this.send(message.channel_id, projects.length === 0
        ? 'No projects are registered. Register one in the dashboard.'
        : projects.map(project => `${project.id} ${project.title}`).join('\n'))
      return
    }
    const run = /^run\s+(\S+)\s+(pi|codex|openclaw)\s+([\s\S]+)$/u.exec(command)
    if (run !== null) {
      const [, workspaceId, executorValue, instruction] = run
      /* v8 ignore next 3 -- The anchored expression requires all three captures for a match. */
      if (workspaceId === undefined || executorValue === undefined || instruction === undefined) {
        throw new Error('invalid run command')
      }
      const executor = executorValue as TaskExecutor
      const workspace = this.ctx.taskControl.listProjects().find(candidate => String(candidate.id) === workspaceId)
      if (workspace === undefined) throw new Error(`project '${workspaceId}' is not registered`)
      const task = await this.ctx.taskControl.create({
        workspaceId: workspace.id,
        executor,
        origin: 'discord',
        instruction,
        discordChannelId: message.channel_id,
      })
      await this.send(message.channel_id, `Task ${task.id} awaits dashboard approval: ${executor} on ${workspace.title}.`)
      return
    }
    const status = /^status(?:\s+(\S+))?$/u.exec(command)
    if (status !== null) {
      const id = status[1]
      if (id !== undefined) {
        const task = this.ctx.taskControl.get(TaskId(id))
        if (task === undefined) throw new Error(`task '${id}' does not exist`)
        await this.send(message.channel_id, formatTask(task))
        return
      }
      const tasks = this.ctx.taskControl.list().slice(0, 10)
      await this.send(message.channel_id, tasks.length === 0 ? 'No tasks recorded.' : tasks.map(formatTask).join('\n'))
      return
    }
    const cancel = /^cancel\s+(\S+)$/u.exec(command)
    if (cancel !== null) {
      const id = cancel[1]
      /* v8 ignore next -- The anchored expression requires its capture for a match. */
      if (id === undefined) throw new Error('invalid cancel command')
      const task = await this.ctx.taskExecution.cancel(TaskId(id))
      await this.send(message.channel_id, `Task ${task.id} cancellation result: ${task.state}.`)
      return
    }
    throw new Error(`unknown command; use '${this.config.prefix} help'`)
  }

  private async notifyTerminalTasks(): Promise<void> {
    if (this.notifying) return
    this.notifying = true
    try {
      for (const task of this.ctx.taskControl.list()) {
        if (task.origin !== 'discord' || task.discord === undefined || task.discord.deliveredAt !== undefined) continue
        if (!isTerminalTaskState(task.state) || !this.channelIds.has(task.discord.channelId)) continue
        await this.send(task.discord.channelId, `Terminal outcome: ${formatTask(task)}`)
        await this.ctx.taskControl.markDiscordDelivered(task.id)
      }
    } finally {
      this.notifying = false
    }
  }

  private connect(): void {
    if (this.stopped) return
    try {
      const socket = new WebSocket(GATEWAY_URL)
      this.socket = socket
      socket.addEventListener('message', (event) => { this.gatewayMessage(socket, event.data) })
      socket.addEventListener('close', () => { this.scheduleReconnect() })
      socket.addEventListener('error', () => { socket.close() })
    } catch {
      this.scheduleReconnect()
    }
  }

  private gatewayMessage(socket: WebSocket, value: unknown): void {
    if (socket !== this.socket || typeof value !== 'string') return
    let payload: GatewayPayload
    try {
      payload = JSON.parse(value) as GatewayPayload
    } catch {
      socket.close(4002, 'invalid gateway payload')
      return
    }
    if (typeof payload.s === 'number') this.sequence = payload.s
    switch (payload.op) {
      case 0:
        if (payload.t === 'MESSAGE_CREATE') void this.handle(payload.d).catch(reportDiscordError)
        return
      case 1:
        this.sendGateway(socket, { op: 1, d: this.sequence })
        return
      case 7:
      case 9:
        socket.close()
        return
      case 10: {
        const interval = gatewayHeartbeatInterval(payload.d)
        if (interval === undefined) {
          socket.close(4002, 'invalid hello')
          return
        }
        this.startHeartbeat(socket, interval)
        this.sendGateway(socket, {
          op: 2,
          d: {
            token: this.config.token,
            intents: INTENTS,
            properties: { os: 'linux', browser: 'dsh-command-center', device: 'dsh-command-center' },
          },
        })
        return
      }
      case 11:
        this.heartbeatAcknowledged = true
        return
    }
  }

  private startHeartbeat(socket: WebSocket, interval: number): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeatAcknowledged = true
    this.heartbeat = setInterval(() => {
      if (!this.heartbeatAcknowledged) {
        socket.close(4000, 'heartbeat timeout')
        return
      }
      this.heartbeatAcknowledged = false
      this.sendGateway(socket, { op: 1, d: this.sequence })
    }, interval)
  }

  private sendGateway(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }

  private scheduleReconnect(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.socket = undefined
    if (this.stopped || this.reconnect !== undefined) return
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined
      this.connect()
    }, 1000)
  }

  private async send(channelId: string, content: string): Promise<void> {
    const response = await fetch(`${API_URL}/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${this.config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: truncateMessage(content), allowed_mentions: { parse: [] } }),
    })
    if (!response.ok) throw new Error(`Discord message delivery failed with status ${response.status}`)
  }
}

function discordMessage(value: unknown): DiscordMessage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = value as Record<string, unknown>
  if (typeof message.id !== 'string' || typeof message.channel_id !== 'string' || typeof message.guild_id !== 'string') return undefined
  if (typeof message.content !== 'string' || message.author === null || typeof message.author !== 'object' || Array.isArray(message.author)) return undefined
  const author = message.author as Record<string, unknown>
  if (typeof author.id !== 'string' || (author.bot !== undefined && typeof author.bot !== 'boolean')) return undefined
  return {
    id: message.id,
    channel_id: message.channel_id,
    guild_id: message.guild_id,
    content: message.content,
    author: { id: author.id, ...(author.bot === undefined ? {} : { bot: author.bot }) },
  }
}

function gatewayHeartbeatInterval(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const interval = (value as Record<string, unknown>).heartbeat_interval
  return typeof interval === 'number' && Number.isFinite(interval) && interval > 0 ? interval : undefined
}

function formatTask(task: Task): string {
  const changes = task.copy?.changes === undefined ? '' : ` changes:${task.copy.changes.state}`
  return `${task.id} ${task.executor} ${task.state}${changes}${task.detail === undefined ? '' : ` — ${task.detail}`}`
}

function truncateMessage(value: string): string {
  const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value), part => part.segment)
  return characters.length <= MAX_MESSAGE_LENGTH ? value : `${characters.slice(0, MAX_MESSAGE_LENGTH - 14).join('')}\n[truncated]`
}

function reportDiscordError(error: unknown): void {
  process.emitWarning(error instanceof Error ? error.message : String(error), { code: 'DSH_DISCORD_COMMAND_ERROR' })
}
