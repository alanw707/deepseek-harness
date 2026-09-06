import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
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

/** Real-model smoke test for the shipped default Web profile; opt in locally with `DSH_COMMAND_CENTER_REAL_FLOW=1`. */
describe.skipIf(process.env.DSH_COMMAND_CENTER_REAL_FLOW !== '1')('command-center real Web flow', () => {
  it('runs Pi in the default profile, preserves the original until apply, and applies the reviewed digest', async () => {
    if (!existsSync(DSH_BIN)) throw new Error('build the dsh bin before running the real command-center flow')
    const home = await mkdtemp(join(tmpdir(), 'dsh-command-center-real-home-'))
    const project = await mkdtemp(join(tmpdir(), 'dsh-command-center-real-project-'))
    const copies = join(home, 'task-copies')
    await mkdir(copies, { mode: 0o700 })
    const original = '# Original\n'
    await writeFile(join(project, 'README.md'), original, { mode: 0o600 })
    const server = execa(process.execPath, [DSH_BIN, '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: REPO_ROOT,
      input: '',
      reject: false,
      timeout: SPAWN_TIMEOUT_MS,
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
      expect(await chat.text()).toContain('dsh-command-center-nav')
      const tasksPage = await fetch(new URL('/command-center', origin), { headers })
      expect(tasksPage.status).toBe(200)
      const tasksHtml = await tasksPage.text()
      expect(tasksHtml).toContain('Move work forward. Keep the final say.')
      const csrf = /const csrf="([A-Za-z0-9_-]+)"/u.exec(tasksHtml)?.[1]
      if (csrf === undefined) throw new Error('Tasks page did not return its CSRF value')
      const dashboardCookie = tasksPage.headers.get('set-cookie')?.split(';', 1)[0]
      if (dashboardCookie === undefined) throw new Error('Tasks page did not return its dashboard session cookie')
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
