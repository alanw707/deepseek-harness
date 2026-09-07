/** Browser client for the authenticated Software Factory API. */

const API = '/command-center/api'

/** Durable task states returned by the host API. */
export type TaskState =
  | 'pending-approval'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Staged change lifecycle states returned by the host API. */
export type ChangeState = 'no-change' | 'pending-review' | 'applying' | 'applied' | 'apply-failed' | 'apply-interrupted'

/** One approved project returned by the host API. */
export interface DashboardWorkspace {
  readonly id: string
  readonly title: string
  readonly path: string
}

/** One task's staged change reference. */
export interface DashboardChangeReference {
  readonly sha256: string
  readonly count: number
  readonly state: ChangeState
  readonly detail?: string | undefined
}

/** One task returned by the host API. */
export interface DashboardTask {
  readonly id: string
  readonly workspaceId: string
  readonly executor: 'pi' | 'codex' | 'openclaw'
  readonly origin: 'dashboard' | 'discord'
  readonly instruction: string
  readonly state: TaskState
  readonly createdAt: string
  readonly updatedAt: string
  readonly detail?: string | undefined
  readonly copy?: { readonly changes?: DashboardChangeReference | undefined } | undefined
  readonly workspace?: DashboardWorkspace | undefined
}

/** Dashboard state projection. */
export interface DashboardState {
  readonly workspaces: readonly DashboardWorkspace[]
  readonly tasks: readonly DashboardTask[]
}

/** Exact content side of one staged file change. */
export interface DashboardChangeSide {
  readonly type: 'file' | 'directory'
  readonly mode: number
  readonly text?: string | undefined
}

/** Exact staged file change. */
export interface DashboardChange {
  readonly path: string
  readonly kind: 'create' | 'modify' | 'delete'
  readonly before?: DashboardChangeSide | undefined
  readonly after?: DashboardChangeSide | undefined
}

/** Exact digest-bound review response. */
export interface DashboardChangeSet {
  readonly sha256: string
  readonly changes: readonly DashboardChange[]
}

/** Error raised when the local dashboard session is no longer valid. */
export class DashboardSessionExpiredError extends Error {
  /** Create the session-expired error. */
  constructor() {
    super('Your Software Factory session expired. Reload the page to reconnect.')
    this.name = 'DashboardSessionExpiredError'
  }
}

/** Error raised for an invalid response or failed API request. */
export class DashboardApiError extends Error {}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DashboardApiError(`${name} response is malformed`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new DashboardApiError(`dashboard response field '${field}' is malformed`)
  return value
}

function number(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new DashboardApiError(`dashboard response field '${field}' is malformed`)
  return value as number
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new DashboardApiError(`dashboard response field '${field}' is malformed`)
  return value
}

function workspace(value: unknown): DashboardWorkspace {
  const row = record(value, 'workspace')
  return { id: string(row.id, 'workspace.id'), title: string(row.title, 'workspace.title'), path: string(row.path, 'workspace.path') }
}

function changeReference(value: unknown): DashboardChangeReference {
  const row = record(value, 'change reference')
  const state = string(row.state, 'change.state')
  if (!['no-change', 'pending-review', 'applying', 'applied', 'apply-failed', 'apply-interrupted'].includes(state)) {
    throw new DashboardApiError('dashboard response change state is malformed')
  }
  const count = number(row.count, 'change.count')
  if (count < 0) throw new DashboardApiError('dashboard response change count is malformed')
  return {
    sha256: string(row.sha256, 'change.sha256'),
    count,
    state: state as ChangeState,
    ...(row.detail === undefined ? {} : { detail: string(row.detail, 'change.detail') }),
  }
}

function task(value: unknown): DashboardTask {
  const row = record(value, 'task')
  const executor = string(row.executor, 'task.executor')
  const origin = string(row.origin, 'task.origin')
  const state = string(row.state, 'task.state')
  if (!['pi', 'codex', 'openclaw'].includes(executor)) throw new DashboardApiError('dashboard response executor is malformed')
  if (!['dashboard', 'discord'].includes(origin)) throw new DashboardApiError('dashboard response origin is malformed')
  if (!['pending-approval', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(state)) {
    throw new DashboardApiError('dashboard response task state is malformed')
  }
  const copy = row.copy === undefined ? undefined : record(row.copy, 'task.copy')
  const changes = copy?.changes === undefined ? undefined : changeReference(copy.changes)
  return {
    id: string(row.id, 'task.id'),
    workspaceId: string(row.workspaceId, 'task.workspaceId'),
    executor: executor as DashboardTask['executor'],
    origin: origin as DashboardTask['origin'],
    instruction: string(row.instruction, 'task.instruction'),
    state: state as TaskState,
    createdAt: string(row.createdAt, 'task.createdAt'),
    updatedAt: string(row.updatedAt, 'task.updatedAt'),
    ...(row.detail === undefined ? {} : { detail: string(row.detail, 'task.detail') }),
    ...(copy === undefined ? {} : { copy: changes === undefined ? {} : { changes } }),
    ...(row.workspace === undefined ? {} : { workspace: workspace(row.workspace) }),
  }
}

/**
 * Parse the state projection at the durable API boundary.
 * @param value - Untrusted response value.
 * @returns Parsed dashboard state.
 */
export function parseDashboardState(value: unknown): DashboardState {
  const row = record(value, 'state')
  return {
    workspaces: array(row.workspaces, 'workspaces').map(workspace),
    tasks: array(row.tasks, 'tasks').map(task),
  }
}

/**
 * Parse a task envelope returned after a lifecycle mutation.
 * @param value - Untrusted response value.
 * @returns Parsed task.
 */
export function parseTaskEnvelope(value: unknown): DashboardTask {
  return task(record(value, 'task envelope').task)
}

/**
 * Parse a workspace envelope returned after registration.
 * @param value - Untrusted response value.
 * @returns Parsed workspace.
 */
export function parseWorkspaceEnvelope(value: unknown): DashboardWorkspace {
  return workspace(record(value, 'workspace envelope').workspace)
}

function side(value: unknown): DashboardChangeSide {
  const row = record(value, 'change side')
  if (row.type !== 'file' && row.type !== 'directory') throw new DashboardApiError('dashboard response change type is malformed')
  const mode = number(row.mode, 'change.mode')
  if (mode < 0) throw new DashboardApiError('dashboard response change mode is malformed')
  return {
    type: row.type,
    mode,
    ...(row.text === undefined ? {} : { text: string(row.text, 'change.text') }),
  }
}

/**
 * Parse exact before/after content returned for review.
 * @param value - Untrusted response value.
 * @returns Parsed exact change set.
 */
export function parseDashboardChangeSet(value: unknown): DashboardChangeSet {
  const row = record(value, 'change set')
  return {
    sha256: string(row.sha256, 'change-set.sha256'),
    changes: array(row.changes, 'change-set.changes').map((value) => {
      const change = record(value, 'change')
      const kind = string(change.kind, 'change.kind')
      if (!['create', 'modify', 'delete'].includes(kind)) throw new DashboardApiError('dashboard response change kind is malformed')
      return {
        path: string(change.path, 'change.path'),
        kind: kind as DashboardChange['kind'],
        ...(change.before === undefined ? {} : { before: side(change.before) }),
        ...(change.after === undefined ? {} : { after: side(change.after) }),
      }
    }),
  }
}

/** Authenticated API client for one browser dashboard session. */
export class DashboardApi {
  private csrf: string | undefined

  /** Open a host-authenticated dashboard session. */
  async open(): Promise<void> {
    const response = await fetch(SESSION_PATH, { credentials: 'same-origin' })
    if (response.status === 401) throw new DashboardSessionExpiredError()
    if (!response.ok) throw new DashboardApiError(`Could not connect to Software Factory (HTTP ${String(response.status)}).`)
    const payload = record(await response.json(), 'session')
    this.csrf = string(payload.csrf, 'session.csrf')
  }

  /**
   * Read current projects and tasks.
   * @returns Current dashboard state.
   */
  async state(): Promise<DashboardState> {
    return parseDashboardState(await this.request('/state'))
  }

  /**
   * Register one project path.
   * @param path - Absolute project path.
   * @returns Registered workspace.
   */
  async createWorkspace(path: string): Promise<DashboardWorkspace> {
    return parseWorkspaceEnvelope(await this.request('/workspaces', { method: 'POST', body: JSON.stringify({ path }) }))
  }

  /**
   * Create one pending-approval task.
   * @param workspaceId - Registered workspace identifier.
   * @param executor - Executor to run in the private snapshot.
   * @param instruction - Bounded executor instruction.
   * @returns Created pending task.
   */
  async createTask(workspaceId: string, executor: DashboardTask['executor'], instruction: string): Promise<DashboardTask> {
    return parseTaskEnvelope(await this.request('/tasks', { method: 'POST', body: JSON.stringify({ workspaceId, executor, instruction }) }))
  }

  /**
   * Run one approved task.
   * @param id - Task identifier.
   * @returns Updated task.
   */
  async run(id: string): Promise<DashboardTask> {
    return parseTaskEnvelope(await this.request(`/tasks/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' }))
  }

  /**
   * Approve one pending task.
   * @param id - Task identifier.
   * @returns Updated task.
   */
  async approve(id: string): Promise<DashboardTask> {
    return parseTaskEnvelope(await this.request(`/tasks/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' }))
  }

  /**
   * Cancel one task.
   * @param id - Task identifier.
   * @returns Updated task.
   */
  async cancel(id: string): Promise<DashboardTask> {
    return parseTaskEnvelope(await this.request(`/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }))
  }

  /**
   * Read exact staged changes for one task.
   * @param id - Task identifier.
   * @returns Exact before/after change set.
   */
  async review(id: string): Promise<DashboardChangeSet> {
    return parseDashboardChangeSet(await this.request(`/tasks/${encodeURIComponent(id)}/changes`))
  }

  /**
   * Apply the exact reviewed digest for one task.
   * @param id - Task identifier.
   * @param sha256 - Exact digest returned by review.
   * @returns Updated task.
   */
  async apply(id: string, sha256: string): Promise<DashboardTask> {
    return parseTaskEnvelope(await this.request(`/tasks/${encodeURIComponent(id)}/apply`, {
      method: 'POST', body: JSON.stringify({ sha256 }),
    }))
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const csrf = this.csrf
    if (csrf === undefined) throw new DashboardApiError('Software Factory session is not open.')
    const headers = new Headers(init.headers)
    headers.set('x-dsh-csrf', csrf)
    if (init.method !== undefined) headers.set('content-type', 'application/json')
    const response = await fetch(`${API}${path}`, { ...init, credentials: 'same-origin', headers })
    if (response.status === 401) throw new DashboardSessionExpiredError()
    const body = await response.text()
    if (!response.ok) {
      let message = ''
      if (body !== '') {
        try {
          const parsed = record(JSON.parse(body), 'error')
          if (typeof parsed.error === 'string') message = parsed.error
        } catch {
          message = body
        }
      }
      throw new DashboardApiError(message || `Software Factory request failed (HTTP ${String(response.status)}).`)
    }
    if (body === '') return {}
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new DashboardApiError('Software Factory returned malformed JSON.')
    }
  }
}

const SESSION_PATH = `${API}/session`
