/** Software Factory route rendered inside the DSH shell. */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Button, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { DashboardApi, DashboardSessionExpiredError, type DashboardChange, type DashboardChangeReference, type DashboardChangeSet, type DashboardTask, type DashboardWorkspace } from './api.ts'
import { NS, type TaskDashboardKey } from './locales.ts'
import css from './TaskDashboardView.module.css'

/** Props composed from the route owner and Software Factory locale. */
export type TaskDashboardViewProps = PropsRuntime<'conversation.route'> & PropsLocale<typeof NS> & { matched: boolean }

type ActionKind = 'start' | 'cancel'
type StatusTone = 'review' | 'running' | 'success' | 'error' | 'info'
type Status = { label: TaskDashboardKey; tone: StatusTone; dot: StateDotState }

const STATUS_CLASSES: Record<StatusTone, string> = {
  review: css.statusReview ?? '',
  running: css.statusRunning ?? '',
  success: css.statusSuccess ?? '',
  error: css.statusError ?? '',
  info: css.statusInfo ?? '',
}

const ACTIVE_STATES: readonly DashboardTask['state'][] = ['pending-approval', 'queued', 'running', 'cancelling']
const EXECUTORS: readonly DashboardTask['executor'][] = ['pi', 'codex', 'openclaw']
const STATUS_KEYS = {
  needsReview: 'needsReview',
  readyToStart: 'readyToStart',
  running: 'running',
  stopping: 'stopping',
  runFailed: 'runFailed',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  noChanges: 'noChanges',
  changesReady: 'changesReady',
  applyingChanges: 'applyingChanges',
  applyFailed: 'applyFailed',
  applyInterrupted: 'applyInterrupted',
  applied: 'applied',
  completed: 'completed',
} as const satisfies Record<string, TaskDashboardKey>
const PROGRESS_KEYS = ['newTask', 'reviewStart', 'reviewChanges', 'apply'] as const satisfies readonly TaskDashboardKey[]
const BEFORE_KEY: TaskDashboardKey = 'before'
const AFTER_KEY: TaskDashboardKey = 'after'

function interpolate(t: TaskDashboardViewProps['t'], key: TaskDashboardKey, value: string | number): string {
  return t(key, { count: value, executor: value, mode: value })
}

function executorName(executor: DashboardTask['executor']): string {
  return executor.charAt(0).toUpperCase() + executor.slice(1)
}

function executorHelp(t: TaskDashboardViewProps['t'], executor: DashboardTask['executor']): string {
  if (executor === 'codex') return t('executorCodex')
  if (executor === 'openclaw') return t('executorOpenclaw')
  return t('executorPi')
}

function referenceOf(task: DashboardTask): DashboardChangeReference | undefined {
  return task.copy?.changes
}

function hasPendingChanges(task: DashboardTask): boolean {
  const reference = referenceOf(task)
  return reference !== undefined && reference.state !== 'no-change' && reference.state !== 'applied'
}

function needsAttention(task: DashboardTask): boolean {
  return ACTIVE_STATES.includes(task.state) || hasPendingChanges(task)
}

function statusOf(task: DashboardTask): Status {
  const reference = referenceOf(task)
  if (task.state === 'pending-approval') return { label: STATUS_KEYS.needsReview, tone: 'review', dot: 'warning' }
  if (task.state === 'queued') return { label: STATUS_KEYS.readyToStart, tone: 'review', dot: 'warning' }
  if (task.state === 'running') return { label: STATUS_KEYS.running, tone: 'running', dot: 'ongoing' }
  if (task.state === 'cancelling') return { label: STATUS_KEYS.stopping, tone: 'running', dot: 'ongoing' }
  if (task.state === 'failed') return { label: STATUS_KEYS.runFailed, tone: 'error', dot: 'error' }
  if (task.state === 'cancelled') return { label: STATUS_KEYS.cancelled, tone: 'error', dot: 'error' }
  if (task.state === 'interrupted') return { label: STATUS_KEYS.interrupted, tone: 'error', dot: 'error' }
  if (reference?.state === 'no-change') return { label: STATUS_KEYS.noChanges, tone: 'info', dot: 'done' }
  if (reference?.state === 'pending-review') return { label: STATUS_KEYS.changesReady, tone: 'review', dot: 'warning' }
  if (reference?.state === 'applying') return { label: STATUS_KEYS.applyingChanges, tone: 'running', dot: 'ongoing' }
  if (reference?.state === 'apply-failed') return { label: STATUS_KEYS.applyFailed, tone: 'error', dot: 'error' }
  if (reference?.state === 'apply-interrupted') return { label: STATUS_KEYS.applyInterrupted, tone: 'error', dot: 'error' }
  if (reference?.state === 'applied') return { label: STATUS_KEYS.applied, tone: 'success', dot: 'done' }
  return { label: STATUS_KEYS.completed, tone: 'success', dot: 'done' }
}

function stageOf(task: DashboardTask): number {
  const reference = referenceOf(task)
  if (ACTIVE_STATES.includes(task.state)) return 1
  if (reference?.state === 'pending-review') return 2
  return 3
}

function formatCount(t: TaskDashboardViewProps['t'], count: number): string {
  return t('taskCount', { count })
}

function actionTitle(t: TaskDashboardViewProps['t'], task: DashboardTask): { title: string; description: string } {
  const executor = executorName(task.executor)
  const reference = referenceOf(task)
  if (task.state === 'pending-approval') return { title: t('reviewRequestStart', { executor }), description: t('privateSnapshot') }
  if (task.state === 'queued') return { title: t('startExecutor', { executor }), description: t('approvedWaiting') }
  if (task.state === 'running') return { title: t('executorWorking', { executor }), description: t('originalUnchanged') }
  if (task.state === 'cancelling') return { title: t('waitingStop', { executor }), description: t('processStopping') }
  if (reference?.state === 'pending-review') return { title: t('reviewProposed'), description: t('inspectApply') }
  if (reference?.state === 'applying') return { title: t('applyingApproved'), description: t('applyingDigest') }
  if (reference?.state === 'apply-failed' || reference?.state === 'apply-interrupted') {
    return { title: t('resolveApply'), description: reference.detail ?? t('applyOutcome') }
  }
  if (reference?.state === 'no-change') return { title: t('noChangesToApply'), description: t('executorNoChanges') }
  if (reference?.state === 'applied') return { title: t('changesApplied'), description: t('exactReviewComplete') }
  if (task.state === 'succeeded') return { title: t('taskComplete'), description: t('noFileChanges') }
  return { title: t('runEnded'), description: t('startNewTask') }
}

function sideText(t: TaskDashboardViewProps['t'], side: DashboardChange['before']): string {
  if (side === undefined) return t('notPresent')
  if (side.type === 'directory') return t('directoryMode', { mode: side.mode.toString(8) })
  return side.text ?? ''
}

/** Render the four-step task lifecycle strip. */
function Progress({ t, task }: { t: TaskDashboardViewProps['t']; task: DashboardTask }) {
  const current = stageOf(task)
  const status = statusOf(task)
  const finished = (status.tone === 'success' || status.tone === 'info') && current === 3
  return (
    <ol className={css.progress} aria-label={t('workflow')}>
      {PROGRESS_KEYS.map((label, index) => {
        const complete = finished || index < current
        const currentStep = !complete && index === current
        return <li className={`${css.progressStep} ${complete ? css.progressDone : ''} ${currentStep || (status.tone === 'error' && index === current) ? css.progressCurrent : ''}`} key={label}>{t(label)}</li>
      })}
    </ol>
  )
}

/** Render one exact before/after side of a reviewed change. */
function DiffSide({ t, side, label }: { t: TaskDashboardViewProps['t']; side: DashboardChange['before']; label: TaskDashboardKey }) {
  return (
    <div className={css.diffPane}>
      <div className={css.diffLabel}>{t(label)}</div>
      <pre className={css.diffScroll} tabIndex={0} aria-label={t(label)}>{sideText(t, side)}</pre>
    </div>
  )
}

/** Render an exact change review and its digest-bound apply action. */
function ChangeReview({
  t,
  api,
  task,
  onApplied,
  onError,
}: {
  t: TaskDashboardViewProps['t']
  api: DashboardApi
  task: DashboardTask
  onApplied: () => Promise<void>
  onError: (error: unknown) => void
}) {
  const reference = referenceOf(task)
  const [review, setReview] = useState<DashboardChangeSet | undefined>()
  const [busy, setBusy] = useState(false)
  if (reference === undefined) return null
  const reviewDescription = reference.state === 'applied'
    ? t('reviewedApplied')
    : reference.state === 'applying'
      ? t('approvedApplying')
      : reference.state === 'no-change'
        ? t('executorMadeNoChanges')
        : reference.state === 'apply-failed' || reference.state === 'apply-interrupted'
          ? t('applyRecorded')
          : t('originalStillUnchanged')
  const loadReview = async () => {
    setBusy(true)
    try {
      setReview(await api.review(task.id))
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  const apply = async () => {
    if (review === undefined || review.sha256 !== reference.sha256) return
    setBusy(true)
    try {
      await api.apply(task.id, review.sha256)
      await onApplied()
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={css.review} aria-labelledby={`review-${task.id}`}>
      <h3 className={css.reviewHeading} id={`review-${task.id}`}>{t('reviewChangesBeforeApply')}</h3>
      <p className={css.reviewIntro}>{t('stagedChanges', { count: reference.count })} · {reviewDescription}</p>
      <div className={css.digestRow}><span>{t('exactDigest')}</span><code className={css.digest} title={reference.sha256}>{reference.sha256}</code></div>
      {reference.detail !== undefined && <p className={css.changeDetail}>{reference.detail}</p>}
      {review === undefined && reference.state === 'pending-review' && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void loadReview() }}>{t('reviewExactChanges')}</Button>
      )}
      {review !== undefined && review.changes.map(change => (
        <article className={css.change} key={`${change.kind}-${change.path}`}>
          <h4 className={css.changeTitle}>{t('changeTitle', { kind: change.kind.toUpperCase(), path: change.path })}</h4>
          <div className={css.diffGrid}>
            <DiffSide t={t} side={change.before} label={BEFORE_KEY} />
            <DiffSide t={t} side={change.after} label={AFTER_KEY} />
          </div>
        </article>
      ))}
      {review !== undefined && reference.state === 'pending-review' && review.sha256 === reference.sha256 && (
        <Button className={css.reviewApply} variant="primary" size="sm" disabled={busy} onClick={() => { void apply() }}>{t('applyExactChanges')}</Button>
      )}
    </section>
  )
}

/** Render one active or historical task card. */
function TaskCard({
  t,
  api,
  task,
  history,
  busy,
  onAction,
  onRefresh,
  onError,
  id,
}: {
  t: TaskDashboardViewProps['t']
  api: DashboardApi
  task: DashboardTask
  history: boolean
  busy: string | undefined
  onAction: (task: DashboardTask, action: ActionKind) => Promise<void>
  onRefresh: () => Promise<void>
  onError: (error: unknown) => void
  id?: string | undefined
}) {
  const status = statusOf(task)
  const action = actionTitle(t, task)
  const actionKey = `${task.id}:action`
  const reference = referenceOf(task)
  const project = task.workspace?.title ?? task.workspaceId
  return (
    <article className={css.taskCard} id={id} data-state={task.state} data-attention={needsAttention(task) || undefined}>
      <div className={css.taskHeading}>
        <div className={css.taskIdent}>
          <span className={css.project} title={task.workspace?.path ?? task.workspaceId}>{project}</span>
          <span className={css.executor}>{executorName(task.executor)}</span>
          <span className={`${css.statusPill} ${STATUS_CLASSES[status.tone]}`}>
            <StateDot state={status.dot} size={8} /> {t(status.label)}
          </span>
        </div>
        <time className={css.taskTime} dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time>
      </div>
      <p className={css.taskInstruction}>{task.instruction}</p>
      {!history && <Progress t={t} task={task} />}
      {!history && (
        <div className={css.nextAction}>
          <div className={css.nextCopy}>
            <span className={css.nextLabel}>{t('nextAction')}</span>
            <strong className={css.nextTitle}>{action.title}</strong>
            <p className={css.nextDescription}>{action.description}</p>
          </div>
          <div className={css.actions}>
            {task.state === 'pending-approval' && <Button variant="primary" size="sm" disabled={busy === actionKey} onClick={() => { void onAction(task, 'start') }}>{t('approveStart', { executor: executorName(task.executor) })}</Button>}
            {task.state === 'queued' && <Button variant="primary" size="sm" disabled={busy === actionKey} onClick={() => { void onAction(task, 'start') }}>{t('startTask')}</Button>}
            {task.state === 'running' && <Button variant="outline" size="sm" disabled={busy === actionKey} onClick={() => { void onAction(task, 'cancel') }}>{t('cancelTask')}</Button>}
            {task.state === 'pending-approval' && <Button className={css.danger} variant="outline" size="sm" disabled={busy === actionKey} onClick={() => { void onAction(task, 'cancel') }}>{t('cancelTask')}</Button>}
            {task.state === 'queued' && <Button className={css.danger} variant="outline" size="sm" disabled={busy === actionKey} onClick={() => { void onAction(task, 'cancel') }}>{t('cancelTask')}</Button>}
          </div>
        </div>
      )}
      {task.detail !== undefined && (
        <details className={css.output}>
          <summary className={css.outputSummary}>{task.state === 'succeeded' ? t('runOutput') : t('taskDetails')}</summary>
          <pre className={css.outputBody} tabIndex={0} aria-label={interpolate(t, 'outputFrom', executorName(task.executor))}>{task.detail}</pre>
        </details>
      )}
      {reference !== undefined && <ChangeReview t={t} api={api} task={task} onApplied={onRefresh} onError={onError} />}
      <div className={css.taskMeta}><span className={css.taskId} title={task.id}>{task.id}</span></div>
    </article>
  )
}

/** Render the Software Factory project setup and task history. */
export function TaskDashboardView({ t }: TaskDashboardViewProps) {
  const apiRef = useRef<DashboardApi | undefined>()
  const [state, setState] = useState<{ workspaces: readonly DashboardWorkspace[]; tasks: readonly DashboardTask[] }>()
  const [error, setError] = useState<unknown>()
  const [sessionExpired, setSessionExpired] = useState(false)
  const [busy, setBusy] = useState<string | undefined>()
  const [executor, setExecutor] = useState<DashboardTask['executor']>('pi')
  const [workspaceId, setWorkspaceId] = useState('')
  const [instruction, setInstruction] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [setupOpen, setSetupOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const setupTouched = useRef(false)
  const sessionExpiredRef = useRef(false)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const api = apiRef.current
    if (api === undefined || sessionExpiredRef.current) return
    try {
      const next = await api.state()
      if (!mounted.current) return
      setState(next)
      setError(undefined)
      sessionExpiredRef.current = false
      setSessionExpired(false)
      if (!setupTouched.current && next.workspaces.length === 0) setSetupOpen(true)
    } catch (nextError) {
      if (!mounted.current) return
      setError(nextError)
      if (nextError instanceof DashboardSessionExpiredError) {
        sessionExpiredRef.current = true
        setSessionExpired(true)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    const api = new DashboardApi()
    apiRef.current = api
    void api.open().then(() => refresh()).catch((nextError: unknown) => {
      if (!mounted.current) return
      setError(nextError)
      if (nextError instanceof DashboardSessionExpiredError) {
        sessionExpiredRef.current = true
        setSessionExpired(true)
      }
    })
    const timer = window.setInterval(() => { void refresh() }, 1000)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
      apiRef.current = undefined
    }
  }, [refresh])

  const runAction = useCallback(async (task: DashboardTask, action: ActionKind) => {
    const api = apiRef.current
    if (api === undefined) return
    const key = `${task.id}:action`
    setBusy(key)
    setError(undefined)
    try {
      if (action === 'start') {
        if (task.state === 'pending-approval') await api.approve(task.id)
        await api.run(task.id)
      } else {
        await api.cancel(task.id)
      }
      await refresh()
    } catch (nextError) {
      setError(nextError)
      if (nextError instanceof DashboardSessionExpiredError) {
        sessionExpiredRef.current = true
        setSessionExpired(true)
      }
    } finally {
      setBusy(undefined)
    }
  }, [refresh])

  const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const api = apiRef.current
    if (api === undefined) return
    setBusy('workspace')
    setError(undefined)
    try {
      await api.createWorkspace(projectPath)
      setProjectPath('')
      setupTouched.current = true
      setSetupOpen(false)
      await refresh()
    } catch (nextError) {
      setError(nextError)
      if (nextError instanceof DashboardSessionExpiredError) {
        sessionExpiredRef.current = true
        setSessionExpired(true)
      }
    } finally {
      setBusy(undefined)
    }
  }

  const createTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const api = apiRef.current
    if (api === undefined || workspaceId === '') return
    setBusy('task')
    setError(undefined)
    try {
      const created = await api.createTask(workspaceId, executor, instruction)
      setInstruction('')
      await refresh()
      document.getElementById(`task-${created.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch (nextError) {
      setError(nextError)
      if (nextError instanceof DashboardSessionExpiredError) {
        sessionExpiredRef.current = true
        setSessionExpired(true)
      }
    } finally {
      setBusy(undefined)
    }
  }

  const showError = useCallback((nextError: unknown) => {
    setError(nextError)
    if (nextError instanceof DashboardSessionExpiredError) {
      sessionExpiredRef.current = true
      setSessionExpired(true)
    }
  }, [])

  const workspaces = state?.workspaces ?? []
  const active = useMemo(() => state?.tasks.filter(needsAttention) ?? [], [state])
  const historical = useMemo(() => state?.tasks.filter(task => !needsAttention(task)) ?? [], [state])
  const errorMessage = error === undefined
    ? undefined
    : error instanceof Error
      ? error.message
      : typeof error === 'string' ? error : JSON.stringify(error)
  const taskApi = apiRef.current
  const canCreate = workspaces.length > 0 && !sessionExpired

  return (
    <main className={css.root} aria-labelledby="software-factory-title">
      <div className={css.page}>
        <header className={css.masthead}>
          <div>
            <p className={css.eyebrow}>{t('softwareFactory')}</p>
            <h1 className={css.title} id="software-factory-title">{t('moveWork')}</h1>
            <p className={css.intro}>{t('intro')}</p>
          </div>
          <div>
            <div className={css.flow} aria-label={t('workflow')}>
              <p className={css.flowTitle}>{t('workflow')}</p>
              <ol className={css.flowSteps}>
                {(['newTask', 'reviewStart', 'reviewChanges', 'apply'] as const).map(key => <li className={css.flowStep} key={key}>{t(key)}</li>)}
              </ol>
            </div>
            <div className={css.local}><StateDot state="done" size={8} />{t('localOnly')}</div>
          </div>
        </header>

        {errorMessage !== undefined && (
          <div className={css.notice} role="alert" aria-live="assertive">
            <span className={css.noticeMessage}>{sessionExpired ? t('sessionExpired') : errorMessage}</span>
            {sessionExpired && <Button className={css.noticeButton} variant="outline" size="sm" onClick={() => { window.location.reload() }}>{t('reload')}</Button>}
          </div>
        )}

        <div className={css.workspaceGrid}>
          <section className={css.panel} aria-labelledby="new-task-title">
            <div className={css.panelHeader}>
              <h2 className={css.panelTitle} id="new-task-title">{t('newTask')}</h2>
              <p className={css.panelIntro}>{t('panelIntro')}</p>
            </div>
            <form onSubmit={(event) => { void createTask(event) }}>
              <div className={css.fieldRow}>
                <label className={css.field}><span className={css.label}>{t('project')}</span>
                  <select
                    className={css.select}
                    required
                    value={workspaceId}
                    disabled={!canCreate}
                    onChange={(event) => { setWorkspaceId(event.target.value) }}
                  >
                    <option value="" disabled>{t('chooseProject')}</option>
                    {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
                  </select>
                </label>
                <label className={css.field}><span className={css.label}>{t('executor')}</span>
                  <select className={css.select} value={executor} disabled={!canCreate} onChange={(event) => { setExecutor(event.target.value as DashboardTask['executor']) }}>
                    {EXECUTORS.map(value => <option key={value} value={value}>{executorName(value)}</option>)}
                  </select>
                </label>
              </div>
              <p className={css.fieldHelp}>{executorHelp(t, executor)}</p>
              <label className={css.field}><span className={css.label}>{t('whatShouldItDo')}</span>
                <textarea className={css.textarea} required value={instruction} disabled={!canCreate} placeholder={t('instructionPlaceholder')} onChange={(event) => { setInstruction(event.target.value) }} />
              </label>
              <div className={css.formFooter}>
                <span className={css.formNote}>{canCreate ? t('nothingRuns') : t('addProjectFirst')}</span>
                <Button variant="primary" type="submit" disabled={!canCreate || busy === 'task'}>{t('continueReview')}</Button>
              </div>
            </form>
          </section>

          <aside className={css.secondaryColumn} aria-label={t('softwareFactory')}>
            <details
              className={css.disclosure}
              open={setupOpen}
              onToggle={(event) => {
                setupTouched.current = true
                setSetupOpen(event.currentTarget.open)
              }}
            >
              <summary className={css.disclosureSummary}>
                <span className={css.disclosureCopy}>
                  <span className={css.disclosureTitle}>{t('projectSetup')}</span>
                  <span className={css.disclosureHint}>{t('projectSetupHint')}</span>
                </span>
              </summary>
              <div className={css.disclosureBody}>
                <p>{t('projectSetupDescription')}</p>
                <form className={css.setupForm} onSubmit={(event) => { void createWorkspace(event) }}>
                  <label className={css.field}>
                    <span className={css.label}>{t('projectPath')}</span>
                    <input
                      className={css.pathInput}
                      required
                      value={projectPath}
                      placeholder={t('projectPathPlaceholder')}
                      autoComplete="off"
                      onChange={(event) => { setProjectPath(event.target.value) }}
                    />
                  </label>
                  <Button variant="outline" type="submit" disabled={busy === 'workspace'}>{t('addProject')}</Button>
                </form>
              </div>
            </details>
            {historical.length > 0 && (
              <details
                className={css.disclosure}
                open={historyOpen}
                onToggle={(event) => { setHistoryOpen(event.currentTarget.open) }}
              >
                <summary className={css.disclosureSummary}>
                  <span className={css.disclosureCopy}>
                    <span className={css.disclosureTitle}>
                      {t('taskHistory')} <span className={css.count}>· {historical.length}</span>
                    </span>
                    <span className={css.disclosureHint}>{t('taskHistoryHint')}</span>
                  </span>
                </summary>
                <div className={css.disclosureBody}>
                  <div className={css.taskList}>
                    {taskApi === undefined ? null : historical.map(task => (
                      <TaskCard
                        key={task.id}
                        t={t}
                        api={taskApi}
                        task={task}
                        history
                        busy={busy}
                        onAction={runAction}
                        onRefresh={refresh}
                        onError={showError}
                      />
                    ))}
                  </div>
                </div>
              </details>
            )}
          </aside>
        </div>

        <section className={css.activeSection} aria-labelledby="attention-title">
          <div className={css.sectionHead}>
            <div>
              <h2 className={css.sectionTitle} id="attention-title">{t('tasksAttention')}</h2>
              <p className={css.sectionDescription}>{t('tasksAttentionDescription')}</p>
            </div>
            <span className={css.count} aria-live="polite">
              {state === undefined ? t('loading') : formatCount(t, state.tasks.length)}
            </span>
          </div>
          {state === undefined ? (
            <p className={css.loading}>{t('loading')}</p>
          ) : active.length === 0 || taskApi === undefined ? (
            <p className={css.empty}>{t('noAttention')}</p>
          ) : (
            <div className={css.taskList}>
              {active.map(task => (
                <TaskCard
                  id={`task-${task.id}`}
                  key={task.id}
                  t={t}
                  api={taskApi}
                  task={task}
                  history={false}
                  busy={busy}
                  onAction={runAction}
                  onRefresh={refresh}
                  onError={showError}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
