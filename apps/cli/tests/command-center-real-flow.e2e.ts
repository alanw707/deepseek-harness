import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const DSH_BIN = join(REPO_ROOT, 'apps/cli/lib/bin.js')
const SPAWN_TIMEOUT_MS = 60_000
const REAL_FLOW_TIMEOUT_MS = 5 * 60_000

interface StateTask {
  readonly id: string
  readonly state: string
  readonly detail?: string
  readonly copy?: {
    readonly changes?: {
      readonly sha256: string
      readonly state: string
    }
  }
}

interface StateResponse {
  readonly tasks: readonly StateTask[]
}

interface HistoryEvent {
  readonly type: string
  readonly data: unknown
}

interface HistoryPage {
  readonly records: readonly { readonly type: 'event'; readonly event: HistoryEvent }[]
  readonly hasMore: boolean
}

interface RpcResponse<T> {
  readonly result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function chatRpc<T>(origin: string, cookie: string, endpoint: string, args: object): Promise<T> {
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `real-flow-${endpoint}-${randomUUID()}`,
      method: endpoint,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`Chat ${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  const body = await response.json() as RpcResponse<T>
  if (!body.result.ok) throw new Error(`Chat ${endpoint} failed: ${body.result.error.code}: ${body.result.error.message}`)
  return body.result.value
}

/** Read the current durable Chat history through the follow path used by the browser client. */
async function chatHistory(origin: string, cookie: string, sessionId: string): Promise<HistoryPage> {
  const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/api/remote.mux`, {
    headers: { cookie },
  })
  const streamId = `real-flow-history-${randomUUID()}`
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', closed)
      }
      const opened = (): void => { cleanup(); resolve() }
      const failed = (event: WebSocket.ErrorEvent): void => {
        cleanup()
        reject(new Error(`Chat history carrier failed before opening: ${event.message}`))
      }
      const closed = (event: WebSocket.CloseEvent): void => {
        cleanup()
        reject(new Error(`Chat history carrier closed before opening: ${String(event.code)} ${event.reason}`))
      }
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
    })
    return await new Promise<HistoryPage>((resolve, reject) => {
      const timer = setTimeout(() => { finish(new Error('Chat history did not publish an opening snapshot')) }, 10_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.removeEventListener('message', message)
        socket.removeEventListener('error', failed)
        socket.removeEventListener('close', closed)
      }
      const finish = (error: Error | undefined, page?: HistoryPage): void => {
        cleanup()
        if (error !== undefined) reject(error)
        else if (page === undefined) reject(new Error('Chat history returned no snapshot'))
        else resolve(page)
      }
      const message = (event: WebSocket.MessageEvent): void => {
        try {
          const text = typeof event.data === 'string'
            ? event.data
            : Buffer.isBuffer(event.data) ? event.data.toString('utf8') : undefined
          if (text === undefined) throw new Error('Chat history published a non-text frame')
          const frame: unknown = JSON.parse(text)
          if (!isRecord(frame) || frame.streamId !== streamId) return
          if (frame.type === 'error') {
            const error = isRecord(frame.error) ? JSON.stringify(frame.error) : 'unknown history error'
            finish(new Error(`Chat history failed: ${error}`))
            return
          }
          if (frame.type === 'end') {
            finish(new Error('Chat history ended before its opening snapshot'))
            return
          }
          if (frame.type !== 'item' || !isRecord(frame.value) || frame.value.type !== 'snapshot') return
          const records = frame.value.records
          if (!Array.isArray(records)) throw new Error('Chat history snapshot omitted records')
          const pageRecords = records.filter((record): record is HistoryPage['records'][number] => {
            if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event)) return false
            return typeof record.event.type === 'string'
          })
          finish(undefined, {
            records: pageRecords,
            hasMore: frame.value.hasMore === true,
          })
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }
      const failed = (event: WebSocket.ErrorEvent): void => { finish(new Error(`Chat history carrier failed: ${event.message}`)) }
      const closed = (event: WebSocket.CloseEvent): void => {
        finish(new Error(`Chat history carrier closed: ${String(event.code)} ${event.reason}`))
      }
      socket.addEventListener('message', message)
      socket.addEventListener('error', failed)
      socket.addEventListener('close', closed)
      socket.send(JSON.stringify({
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId } } } },
      }))
    })
  } finally {
    socket.close()
  }
}

function messageText(page: HistoryPage, types: readonly string[]): string {
  return page.records.flatMap((record) => {
    if (!types.includes(record.event.type)) return []
    if (!isRecord(record.event.data) || !isRecord(record.event.data.message)) return []
    const content = record.event.data.message.content
    if (!Array.isArray(content)) return []
    return content.flatMap(block => isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : [])
  }).join('\n')
}

function historyText(page: HistoryPage): string {
  return messageText(page, ['user/message', 'assistant/message'])
}

function assistantText(page: HistoryPage): string {
  return messageText(page, ['assistant/message'])
}

async function waitForChatResponse(origin: string, cookie: string, sessionId: string): Promise<HistoryPage> {
  const deadline = Date.now() + 180_000
  while (true) {
    const page = await chatHistory(origin, cookie, sessionId)
    if (assistantText(page).trim() !== '') return page
    if (Date.now() >= deadline) throw new Error('Chat assistant response was not durable within 180s')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/** Real-model smoke test for the shipped default Web profile; opt in locally with `DSH_COMMAND_CENTER_REAL_FLOW=1`. */
describe.skipIf(process.env.DSH_COMMAND_CENTER_REAL_FLOW !== '1')('command-center real Web flow', () => {
  it('runs Pi in the default profile, preserves the original until apply, and applies the reviewed digest', async () => {
    if (!existsSync(DSH_BIN)) throw new Error('build the dsh bin before running the real command-center flow')
    const home = await mkdtemp(join(tmpdir(), 'dsh-command-center-real-home-'))
    const project = await mkdtemp(join(tmpdir(), 'dsh-command-center-real-project-'))
    const copies = join(home, 'task-copies')
    await mkdir(copies, { mode: 0o700 })
    const userDshHome = process.env.HOME === undefined ? undefined : join(process.env.HOME, '.dsh')
    const userCredentials = userDshHome === undefined ? undefined : join(userDshHome, '.credentials.yaml')
    const userSettings = userDshHome === undefined ? undefined : join(userDshHome, 'settings.yaml')
    if (userCredentials !== undefined && existsSync(userCredentials)) {
      await writeFile(join(home, '.credentials.yaml'), await readFile(userCredentials), { mode: 0o600 })
    }
    if (!process.env.DEEPSEEK_API_KEY && userSettings !== undefined && userCredentials !== undefined
      && existsSync(userSettings) && existsSync(userCredentials)) {
      await writeFile(join(home, 'settings.yaml'), await readFile(userSettings), { mode: 0o600 })
    }
    const original = '# Original\n'
    await writeFile(join(project, 'README.md'), original, { mode: 0o600 })
    const server = execa(process.execPath, [DSH_BIN, '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: REPO_ROOT,
      input: '',
      reject: false,
      timeout: REAL_FLOW_TIMEOUT_MS + SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      extendEnv: false,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_COMMAND_CENTER_COPIES: copies,
        DSH_TELEMETRY_DISABLED: '1',
      },
    })
    let serverExited = false
    void server.then(() => { serverExited = true })
    try {
      const output = createInterface({ input: server.stdout })
      const launchLine = await new Promise<string>((resolve, reject) => {
        let lineFound = false
        output.on('line', (line: string) => {
          if (!line.startsWith('dsh web: ')) return
          lineFound = true
          output.close()
          resolve(line)
        })
        void server.then((result) => {
          if (!lineFound) reject(new Error(`default Web profile exited with code ${String(result.exitCode ?? -1)}\n${result.stderr}`))
        }, reject)
      })
      const launchUrl = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)$/u.exec(launchLine)?.[1]
      if (launchUrl === undefined) throw new Error(`unexpected Web launch line: ${launchLine}`)
      const exchange = await fetch(launchUrl, { redirect: 'manual' })
      expect(exchange.status).toBe(303)
      const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
      if (cookie === undefined) throw new Error('Web launch did not return a browser session cookie')
      const origin = new URL(launchUrl).origin
      const headers = { cookie, 'content-type': 'application/json' }
      const chat = await fetch(origin, { headers })
      expect(chat.status).toBe(200)
      expect(await chat.text()).toMatch(/<div id="root"><\/div>/u)
      const chatPromptMarker = `CHAT_REAL_FLOW_PROMPT_${randomUUID()}`
      const createdChat = await chatRpc<{ sessionId: string }>(origin, cookie, 'session/create', {
        request: { cwd: project },
      })
      await chatRpc<{ accepted: true }>(origin, cookie, 'session/prompt', {
        request: {
          requestId: randomUUID(),
          sessionId: createdChat.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: `Reply briefly and do not modify files. Include CHAT_REAL_FLOW_OK. Test prompt ${chatPromptMarker}` }],
        },
      })
      const chatHistoryPage = await waitForChatResponse(origin, cookie, createdChat.sessionId)
      expect(historyText(chatHistoryPage)).toContain(chatPromptMarker)
      expect(assistantText(chatHistoryPage)).not.toBe('')
      const tasksPage = await fetch(new URL('/command-center', origin), { headers })
      expect(tasksPage.status).toBe(200)
      const tasksHtml = await tasksPage.text()
      expect(tasksHtml).toMatch(/<div id="root"><\/div>/u)
      const dashboardSession = await fetch(new URL('/command-center/api/session', origin), { headers })
      expect(dashboardSession.status).toBe(200)
      const csrf = (await dashboardSession.json() as { csrf?: unknown }).csrf
      if (typeof csrf !== 'string') throw new Error('Software Factory session did not return its CSRF value')
      const dashboardCookie = dashboardSession.headers.get('set-cookie')?.split(';', 1)[0]
      if (dashboardCookie === undefined) throw new Error('Software Factory session did not return its browser cookie')
      const apiHeaders = { ...headers, cookie: `${cookie}; ${dashboardCookie}`, 'x-dsh-csrf': csrf }

      const register = await fetch(new URL('/command-center/api/workspaces', origin), {
        method: 'POST', headers: apiHeaders, body: JSON.stringify({ path: project }),
      })
      expect(register.status).toBe(201)
      const workspaceId = (await register.json() as { workspace: { id: string } }).workspace.id
      const create = await fetch(new URL('/command-center/api/tasks', origin), {
        method: 'POST', headers: apiHeaders,
        body: JSON.stringify({
          workspaceId,
          executor: 'pi',
          instruction: 'Create REAL_FLOW.txt containing exactly: real model flow complete. Make no other changes.',
        }),
      })
      expect(create.status).toBe(201)
      const taskId = (await create.json() as { task: { id: string } }).task.id
      const approve = await fetch(new URL(`/command-center/api/tasks/${taskId}/approve`, origin), {
        method: 'POST', headers: apiHeaders, body: '{}',
      })
      expect(approve.status).toBe(200)
      const run = await fetch(new URL(`/command-center/api/tasks/${taskId}/run`, origin), {
        method: 'POST', headers: apiHeaders, body: '{}',
      })
      expect(run.status).toBe(200)
      expect(await readFile(join(project, 'README.md'), 'utf8')).toBe(original)
      expect(existsSync(join(project, 'REAL_FLOW.txt'))).toBe(false)

      const deadline = Date.now() + REAL_FLOW_TIMEOUT_MS
      let settled: StateTask | undefined
      while (settled === undefined) {
        const stateResponse = await fetch(new URL('/command-center/api/state', origin), { headers: apiHeaders })
        expect(stateResponse.status).toBe(200)
        const state = await stateResponse.json() as StateResponse
        const task = state.tasks.find(candidate => candidate.id === taskId)
        if (task === undefined) throw new Error(`real task ${taskId} disappeared from state`)
        if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) settled = task
        else {
          if (Date.now() >= deadline) throw new Error(`real task ${taskId} did not settle within ${REAL_FLOW_TIMEOUT_MS / 1_000}s`)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      expect(settled.state, settled.detail).toBe('succeeded')
      expect(settled.copy?.changes?.state).toBe('pending-review')
      expect(await readFile(join(project, 'README.md'), 'utf8')).toBe(original)
      expect(existsSync(join(project, 'REAL_FLOW.txt'))).toBe(false)

      const review = await fetch(new URL(`/command-center/api/tasks/${taskId}/changes`, origin), { headers: apiHeaders })
      expect(review.status).toBe(200)
      const changeSet = (await review.json()) as unknown as {
        sha256: string
        changes: readonly { path: string; kind: string; before?: object; after?: { text?: unknown } }[]
      }
      expect(changeSet.changes).toHaveLength(1)
      const change = changeSet.changes[0]
      if (change === undefined) throw new Error('real flow review returned no change')
      expect(change.path).toBe('REAL_FLOW.txt')
      expect(change.kind).toBe('create')
      expect(change.after).toBeDefined()
      expect(change).not.toHaveProperty('before')
      const reviewedText = change.after?.text
      expect(reviewedText).toEqual(expect.any(String))
      const apply = await fetch(new URL(`/command-center/api/tasks/${taskId}/apply`, origin), {
        method: 'POST', headers: apiHeaders, body: JSON.stringify({ sha256: changeSet.sha256 }),
      })
      expect(apply.status).toBe(200)
      expect(await readFile(join(project, 'README.md'), 'utf8')).toBe(original)
      expect(await readFile(join(project, 'REAL_FLOW.txt'), 'utf8')).toBe(reviewedText)
      expect(await readdir(project)).toEqual(['README.md', 'REAL_FLOW.txt'])
    } finally {
      if (!serverExited) server.kill('SIGTERM')
      await server
      await rm(project, { recursive: true, force: true })
      await rm(home, { recursive: true, force: true })
    }
  }, REAL_FLOW_TIMEOUT_MS + SPAWN_TIMEOUT_MS)
})
