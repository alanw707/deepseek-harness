import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { TaskId, type Task, type TaskRequest } from '@deepseek-ai/dsh-task-control'
import { DiscordTaskIngress, type DiscordIngressConfig } from '../src/discord.ts'

const USER_ID = '111111111111111111'
const GUILD_ID = '222222222222222222'
const CHANNEL_ID = '333333333333333333'
const DM_CHANNEL_ID = '555555555555555555'
const WORKSPACE_ID = 'project' as WorkspaceId

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly instances: FakeWebSocket[] = []
  static failConstruction = false
  readyState = FakeWebSocket.OPEN
  readonly sent: string[] = []
  readonly closed: Array<{ code?: number; reason?: string }> = []
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>()

  constructor(readonly url: string) {
    if (FakeWebSocket.failConstruction) throw new Error('gateway unavailable')
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

function config(): DiscordIngressConfig {
  return {
    token: 'dedicated-test-token',
    userId: USER_ID,
    guildIds: [GUILD_ID],
    channelIds: [CHANNEL_ID],
    prefix: '!cc',
  }
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TaskId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    workspaceId: WORKSPACE_ID,
    executor: 'pi',
    origin: 'discord',
    instruction: 'inspect project',
    state: 'pending-approval',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    discord: { channelId: CHANNEL_ID },
    ...overrides,
  }
}

function message(content: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    id: '444444444444444444',
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    content,
    author: { id: USER_ID },
    ...overrides,
  }
}

function successfulFetch() {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }))
}

function sentBody(fetch: ReturnType<typeof successfulFetch>, index: number): { content: string; allowed_mentions: unknown } {
  const body = fetch.mock.calls[index]?.[1]?.body
  if (typeof body !== 'string') throw new Error('expected a string Discord request body')
  const parsed: unknown = JSON.parse(body)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a Discord request object')
  const record = parsed as Record<string, unknown>
  if (typeof record.content !== 'string') throw new Error('expected Discord request content')
  return { content: record.content, allowed_mentions: record.allowed_mentions }
}

function harness(currentTasks: Task[] = [task()]) {
  const requests: TaskRequest[] = []
  const created = task()
  const taskControl = {
    create: vi.fn(async (request: TaskRequest) => {
      requests.push(request)
      return created
    }),
    get: vi.fn((id: ReturnType<typeof TaskId>) => currentTasks.find(value => value.id === id)),
    list: vi.fn(() => currentTasks),
    listProjects: vi.fn(() => [{ id: WORKSPACE_ID, title: 'Demo project', path: '/demo', approvedAt: 'now' }]),
    markDiscordDelivered: vi.fn(async (id: ReturnType<typeof TaskId>) => task({ id, state: 'succeeded', discord: { channelId: CHANNEL_ID, deliveredAt: 'now' } })),
  }
  const taskExecution = {
    cancel: vi.fn(async (id: ReturnType<typeof TaskId>) => task({ id, state: 'cancelled' })),
  }
  const ctx = { taskControl, taskExecution } as unknown as Context
  return { ingress: new DiscordTaskIngress(ctx, config()), requests, taskControl, taskExecution }
}

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  FakeWebSocket.instances.length = 0
  FakeWebSocket.failConstruction = false
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('DiscordTaskIngress', () => {
  it('ignores every source outside the exact user, server, and channel allowlists', async () => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    const result = harness()

    await result.ingress.handle(message('!cc projects', { author: { id: '999999999999999999' } }))
    await result.ingress.handle(message('!cc projects', { guild_id: '999999999999999999' }))
    await result.ingress.handle(message('!cc projects', { channel_id: '999999999999999999' }))
    await result.ingress.handle(message('!cc projects', { author: { id: USER_ID, bot: true } }))
    await result.ingress.handle({ malformed: true })

    expect(fetch).not.toHaveBeenCalled()
    expect(result.taskControl.create).not.toHaveBeenCalled()
  })

  it('accepts authorized direct messages without guild or channel allowlists', async () => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    const result = harness()

    await result.ingress.handle(message(`!cc run ${WORKSPACE_ID} pi inspect`, { guild_id: undefined, channel_id: DM_CHANNEL_ID }))

    expect(result.requests).toEqual([{
      workspaceId: WORKSPACE_ID,
      executor: 'pi',
      origin: 'discord',
      instruction: 'inspect',
      discordChannelId: DM_CHANNEL_ID,
    }])
    expect(fetch).toHaveBeenCalledOnce()
    expect(sentBody(fetch, 0).content).toContain('awaits dashboard approval')
  })

  it('acknowledges a durable request while leaving approval and dispatch to the dashboard', async () => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    const result = harness()

    await result.ingress.handle(message(`!cc run ${WORKSPACE_ID} codex update README`))

    expect(result.requests).toEqual([{
      workspaceId: WORKSPACE_ID,
      executor: 'codex',
      origin: 'discord',
      instruction: 'update README',
      discordChannelId: CHANNEL_ID,
    }])
    expect(fetch).toHaveBeenCalledOnce()
    const body = sentBody(fetch, 0)
    expect(body.content).toContain('awaits dashboard approval')
    expect(body.allowed_mentions).toEqual({ parse: [] })
  })

  it('reports status and routes cancellation through owned process-tree cancellation', async () => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    const running = task({ state: 'running' })
    const result = harness([running])

    await result.ingress.handle(message(`!cc status ${running.id}`))
    await result.ingress.handle(message(`!cc cancel ${running.id}`))

    expect(result.taskExecution.cancel).toHaveBeenCalledWith(running.id)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sentBody(fetch, 0).content).toContain('pi running')
    expect(sentBody(fetch, 1).content).toContain('cancellation result: cancelled')
  })

  it('supports help, project listing, status listing, and rejected command replies', async () => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    const result = harness([])

    await result.ingress.handle(message('not a command'))
    await result.ingress.handle(message('!cc help'))
    await result.ingress.handle(message('!cc projects'))
    await result.ingress.handle(message('!cc status'))
    await result.ingress.handle(message('!cc status missing'))
    await result.ingress.handle(message('!cc run missing pi inspect'))
    await result.ingress.handle(message('!cc unknown'))

    expect(fetch).toHaveBeenCalledTimes(6)
    expect(sentBody(fetch, 0).content).toContain('projects | run')
    expect(sentBody(fetch, 1).content).toContain('Demo project')
    expect(sentBody(fetch, 2).content).toBe('No tasks recorded.')
    expect(sentBody(fetch, 3).content).toContain('does not exist')
    expect(sentBody(fetch, 4).content).toContain('is not registered')
    expect(sentBody(fetch, 5).content).toContain('unknown command')

    result.taskControl.listProjects.mockReturnValue([])
    await result.ingress.handle(message('!cc projects'))
    expect(sentBody(fetch, 6).content).toContain('No projects are registered')
  })

  it('formats bounded task lists, details, change state, and grapheme-safe truncation', async () => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    const changed = task({
      detail: '🙂'.repeat(2_000),
      copy: {
        root: '/private', original: '/demo', manifestSha256: 'a'.repeat(64),
        changes: { sha256: 'b'.repeat(64), count: 1, state: 'pending-review' },
      },
    })
    const tasks = [...Array.from({ length: 11 }, (_, index) => task({ id: TaskId(`task-${String(index)}`) })), changed]
    const result = harness(tasks)

    await result.ingress.handle(message(`!cc status ${changed.id}`))
    await result.ingress.handle(message('!cc status'))
    expect(sentBody(fetch, 0).content).toContain('changes:pending-review')
    expect(sentBody(fetch, 0).content.endsWith('\n[truncated]')).toBe(true)
    expect(sentBody(fetch, 1).content.split('\n')).toHaveLength(10)
  })

  it('reports string failures and propagates Discord API delivery failures', async () => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    const result = harness()
    result.taskControl.create.mockRejectedValueOnce('durability unavailable')
    await result.ingress.handle(message(`!cc run ${WORKSPACE_ID} pi inspect`))
    expect(sentBody(fetch, 0).content).toContain('durability unavailable')

    globalThis.fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 503 }))
    await expect(result.ingress.handle(message('!cc help'))).rejects.toThrow('status 503')
  })

  it.each([
    null, [], {},
    { id: 1, channel_id: CHANNEL_ID, guild_id: GUILD_ID, content: '!cc help', author: { id: USER_ID } },
    { id: '1', channel_id: 2, guild_id: GUILD_ID, content: '!cc help', author: { id: USER_ID } },
    { id: '1', channel_id: CHANNEL_ID, guild_id: 3, content: '!cc help', author: { id: USER_ID } },
    { id: '1', channel_id: CHANNEL_ID, guild_id: GUILD_ID, content: 4, author: { id: USER_ID } },
    { id: '1', channel_id: CHANNEL_ID, guild_id: GUILD_ID, content: '!cc help', author: null },
    { id: '1', channel_id: CHANNEL_ID, guild_id: GUILD_ID, content: '!cc help', author: [] },
    { id: '1', channel_id: CHANNEL_ID, guild_id: GUILD_ID, content: '!cc help', author: { id: 1 } },
    { id: '1', channel_id: CHANNEL_ID, guild_id: GUILD_ID, content: '!cc help', author: { id: USER_ID, bot: 'yes' } },
  ])('ignores malformed Discord message %#', async (value) => {
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    await harness().ingress.handle(value)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('handles every Gateway opcode, heartbeat timeout, and malformed payload', async () => {
    vi.useFakeTimers()
    globalThis.fetch = successfulFetch()
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const dormant = harness()
    dormant.ingress.stop()
    ;(dormant.ingress as unknown as { connect(): void }).connect()
    expect(FakeWebSocket.instances).toHaveLength(0)
    const result = harness()
    result.ingress.start()
    const socket = FakeWebSocket.instances[0]!

    socket.emit('message', Buffer.from('{}'))
    socket.emit('message', '{')
    expect(socket.closed).toContainEqual({ code: 4002, reason: 'invalid gateway payload' })
    socket.emit('message', JSON.stringify({ op: 10, d: null }))
    socket.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 0 } }))
    expect(socket.closed).toContainEqual({ code: 4002, reason: 'invalid hello' })
    socket.emit('message', JSON.stringify({ op: 1, s: 9 }))
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ op: 1, d: 9 })
    socket.emit('message', JSON.stringify({ op: 7 }))
    socket.emit('message', JSON.stringify({ op: 9 }))
    socket.emit('message', JSON.stringify({ op: 11 }))
    socket.emit('message', JSON.stringify({ op: 0, t: 'OTHER', d: {} }))
    socket.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }))
    socket.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }))
    await vi.advanceTimersByTimeAsync(100)
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ op: 1, d: 9 })
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.closed).toContainEqual({ code: 4000, reason: 'heartbeat timeout' })
    socket.readyState = 0
    const count = socket.sent.length
    socket.emit('message', JSON.stringify({ op: 1 }))
    expect(socket.sent).toHaveLength(count)
    socket.emit('error')
    socket.emit('close')
    result.ingress.stop()
  })

  it('reconnects once after close and retries synchronous construction failure', async () => {
    vi.useFakeTimers()
    globalThis.fetch = successfulFetch()
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const result = harness()
    result.ingress.start()
    const first = FakeWebSocket.instances[0]!
    first.emit('close')
    first.emit('close')
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    result.ingress.stop()

    FakeWebSocket.failConstruction = true
    const retrying = harness()
    retrying.ingress.start()
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.failConstruction = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeWebSocket.instances).toHaveLength(3)
    retrying.ingress.stop()
  })

  it('skips ineligible terminal notifications and prevents overlapping notifier runs', async () => {
    vi.useFakeTimers()
    const skipped = [
      task({ origin: 'dashboard' }),
      task({ discord: undefined }),
      task({ discord: { channelId: CHANNEL_ID, deliveredAt: 'already' }, state: 'failed' }),
      task({ state: 'running' }),
    ]
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const result = harness(skipped)
    result.ingress.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).not.toHaveBeenCalled()
    result.ingress.stop()

    let release!: () => void
    const pending = new Promise<Response>((resolve) => { release = () => { resolve(new Response(null, { status: 200 })) } })
    globalThis.fetch = vi.fn<typeof globalThis.fetch>(async () => await pending)
    const eligible = harness([task({ state: 'failed' })])
    const internals = eligible.ingress as unknown as { notifyTerminalTasks(): Promise<void> }
    const first = internals.notifyTerminalTasks()
    await internals.notifyTerminalTasks()
    expect(globalThis.fetch).toHaveBeenCalledOnce()
    release()
    await first
  })

  it('reports rejected asynchronous Gateway commands without crashing ingress', async () => {
    vi.useFakeTimers()
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('gateway send failed'))
      .mockRejectedValueOnce('network down')
    globalThis.fetch = fetch
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const result = harness()
    result.ingress.start()
    const payload = JSON.stringify({ op: 0, t: 'MESSAGE_CREATE', d: message('!cc unknown') })
    FakeWebSocket.instances[0]!.emit('message', payload)
    await vi.advanceTimersByTimeAsync(0)
    FakeWebSocket.instances[0]!.emit('message', payload)
    await vi.advanceTimersByTimeAsync(0)
    expect(warning).toHaveBeenCalledWith('gateway send failed', { code: 'DSH_DISCORD_COMMAND_ERROR' })
    expect(warning).toHaveBeenCalledWith('network down', { code: 'DSH_DISCORD_COMMAND_ERROR' })
    result.ingress.stop()
  })

  it('identifies through the dedicated Gateway and durably reports terminal outcomes', async () => {
    vi.useFakeTimers()
    const fetch = successfulFetch()
    globalThis.fetch = fetch
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const complete = task({ state: 'succeeded', detail: 'exit code: 0', discord: { channelId: DM_CHANNEL_ID } })
    const result = harness([complete])

    result.ingress.start()
    const socket = FakeWebSocket.instances[0]!
    expect(socket.url).toContain('gateway.discord.gg')
    socket.emit('message', JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }))
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      op: 2,
      d: { token: 'dedicated-test-token', intents: 1 | (1 << 9) | (1 << 12) | (1 << 15) },
    })

    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).toHaveBeenCalledOnce()
    expect(sentBody(fetch, 0).content).toContain('Terminal outcome:')
    expect(result.taskControl.markDiscordDelivered).toHaveBeenCalledWith(complete.id)
    result.ingress.stop()
  })
})
