/** Durable command-center task records. */

import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { TaskId, TaskState } from './types.ts'
const workspaceId = z.string().min(1).transform(value => brandString<WorkspaceId>(value))
const taskApproval = z.object({
  approvedAt: z.string().min(1),
  consumedAt: z.string().min(1).optional(),
})
const taskState = z.enum([
  'pending-approval',
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] satisfies readonly TaskState[])

/** Durable representation of one command-center task. */
export const taskRecord = z.object({
  workspaceId,
  executor: z.enum(['pi', 'codex', 'openclaw']),
  origin: z.enum(['dashboard', 'discord']),
  instruction: z.string().min(1),
  state: taskState,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  approval: taskApproval.optional(),
  copy: z.object({
    root: z.string().refine(isAbsolute, 'task copy root must be absolute'),
    original: z.string().refine(isAbsolute, 'task original directory must be absolute'),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    changes: z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      count: z.number().int().nonnegative(),
      state: z.enum(['no-change', 'pending-review', 'applying', 'applied', 'apply-failed', 'apply-interrupted']),
      approval: z.object({
        approvedAt: z.string().min(1),
        consumedAt: z.string().min(1),
      }).optional(),
      appliedAt: z.string().min(1).optional(),
      detail: z.string().min(1).optional(),
    }).optional(),
  }).optional(),
  detail: z.string().min(1).optional(),
  discord: z.object({
    channelId: z.string().regex(/^\d{17,20}$/u),
    deliveredAt: z.string().min(1).optional(),
  }).optional(),
})

/** One durable task record. */
export type TaskRecord = z.infer<typeof taskRecord>

/** Explicit command-center project approval. */
export const projectRecord = z.object({
  title: z.string().min(1),
  path: z.string().refine(isAbsolute, 'approved project path must be absolute'),
  approvedAt: z.string().min(1),
})

/** One durable approved-project record. */
export type ProjectRecord = z.infer<typeof projectRecord>

/** Task-control persistence declaration. */
export const taskControlDomainSpec = defineDomain({
  name: 'task_control',
  version: 1,
  tables: {
    tasks: domainTable<TaskId, TaskRecord>(taskRecord),
    projects: domainTable<WorkspaceId, ProjectRecord>(projectRecord),
  },
})
