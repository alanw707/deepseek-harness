/** Public task-control types. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Stable identifier for one command-center task. */
export type TaskId = Branded<'TaskId'>

/** One folder explicitly approved for command-center tasks. */
export interface CommandCenterProject {
  /** Shared workspace identity used by durable task records. */
  readonly id: WorkspaceId
  /** Current workspace display title. */
  readonly title: string
  /** Canonical approved directory path. */
  readonly path: string
  /** Time the command center recorded explicit registration. */
  readonly approvedAt: string
}

/** Supported agent runtime selected for a task. */
export type TaskExecutor = 'pi' | 'codex' | 'openclaw'

/** Where the task request entered the command center. */
export type TaskOrigin = 'dashboard' | 'discord'

/** Persisted task lifecycle state. */
export type TaskState =
  | 'pending-approval'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** State that consumes the project's one active execution slot. */
export type ActiveTaskState = 'pending-approval' | 'queued' | 'running' | 'cancelling'

/** Terminal task states. */
export type TerminalTaskState = 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

/** One dashboard decision authorizing one task execution. */
export interface TaskApproval {
  /** Time the dashboard recorded the user's explicit decision. */
  readonly approvedAt: string
  /** Time the executor consumed the one-shot decision before process launch. */
  readonly consumedAt?: string | undefined
}

/** Discord delivery state retained across command-center restarts. */
export interface DiscordTaskDelivery {
  /** Authorized channel that accepted the task. */
  readonly channelId: string
  /** Time its terminal outcome was delivered. */
  readonly deliveredAt?: string | undefined
}

/** Durable state of one exact staged change set. */
export type TaskChangeState = 'pending-review' | 'applying' | 'applied' | 'apply-failed' | 'apply-interrupted'

/** Dashboard decision bound to one exact staged change set. */
export interface TaskChangeApproval {
  /** Time the dashboard approved the displayed change-set digest. */
  readonly approvedAt: string
  /** Time the apply operation consumed that approval before touching the project. */
  readonly consumedAt: string
}

/** Durable reference to exact changes derived after successful execution. */
export interface TaskChangeSetReference {
  /** SHA-256 of the exact private change-set manifest bytes. */
  readonly sha256: string
  /** Number of created, modified, and deleted files. */
  readonly count: number
  /** Current review/apply lifecycle state. */
  readonly state: TaskChangeState
  /** Dashboard decision consumed by an apply attempt. */
  readonly approval?: TaskChangeApproval | undefined
  /** Time a successful apply completed. */
  readonly appliedAt?: string | undefined
  /** Apply failure or interrupted-apply explanation. */
  readonly detail?: string | undefined
}

/** Location and fingerprints of a prepared project snapshot. */
export interface TaskCopyReference {
  /** Private root containing the workspace, baseline, and manifests. */
  readonly root: string
  /** Canonical original project directory recorded before execution. */
  readonly original: string
  /** SHA-256 of the exact baseline manifest bytes. */
  readonly manifestSha256: string
  /** Exact staged changes, present after a successful executor settles. */
  readonly changes?: TaskChangeSetReference | undefined
}

/** One durable task visible to every command-center entry point. */
export interface Task {
  /** Stable task identifier. */
  readonly id: TaskId
  /** Project whose registered directory the executor may use. */
  readonly workspaceId: WorkspaceId
  /** Selected task executor. */
  readonly executor: TaskExecutor
  /** Request entry point. */
  readonly origin: TaskOrigin
  /** User-approved task instructions. */
  readonly instruction: string
  /** Current durable lifecycle state. */
  readonly state: TaskState
  /** Time at which the request was accepted. */
  readonly createdAt: string
  /** Time at which the task last changed state. */
  readonly updatedAt: string
  /** Explicit dashboard decision, present after pending approval becomes queued. */
  readonly approval?: TaskApproval | undefined
  /** Terminal or interruption explanation. */
  readonly detail?: string | undefined
  /** Discord reply destination and terminal-notification state. */
  readonly discord?: DiscordTaskDelivery | undefined
  /** Prepared snapshot; absent for tasks created before isolated-copy execution. */
  readonly copy?: TaskCopyReference | undefined
}

/** Values accepted when a caller creates a task. */
export interface TaskRequest {
  /** Existing registered project. */
  readonly workspaceId: WorkspaceId
  /** Agent runtime to run after approval. */
  readonly executor: TaskExecutor
  /** Dashboard or Discord request path. */
  readonly origin: TaskOrigin
  /** Non-blank instructions for the executor. */
  readonly instruction: string
  /** Authorized reply channel for a Discord request. */
  readonly discordChannelId?: string | undefined
}
