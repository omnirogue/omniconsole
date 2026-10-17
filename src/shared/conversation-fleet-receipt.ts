import { z } from 'zod'
import { conversationFleetAdmitRequest } from './console-conversation-fleet-schemas'
import type {
  ConsoleJobRecord,
  ConsoleWorkflowJob,
  ConsoleWorkflowProgress
} from './console-workflow-types'

export const conversationFleetReceipt = z.object({
  workflowId: z.string().regex(/^wf_[A-Za-z0-9_-]{1,128}$/),
  taskId: z.string().regex(/^btk_[A-Za-z0-9]{4,64}$/),
  rowKey: z.string().min(1).max(1000),
  sessionKey: z.string().max(1000).nullable(),
  title: z.string().min(1).max(500),
  createdAt: z.string().datetime(),
  capturedAt: z.string().datetime().optional(),
  machine: z.string().max(256).nullable(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  intent: z
    .object({
      operationId: z.string().min(1).max(256),
      request: conversationFleetAdmitRequest,
      source: z
        .object({
          sourceHostId: z.string().min(1),
          sourceSessionId: z.string().min(1),
          sourceWorkspacePath: z.string(),
          transcript: z.string(),
          sourceRawTranscript: z.string(),
          sourceTurnId: z.string().optional(),
          sourceRuntimeFence: z.number().optional()
        })
        .passthrough()
    })
    .optional(),
  admission: z.enum(['pending', 'accepted']).default('accepted')
})

export type ConversationFleetReceipt = Omit<
  z.output<typeof conversationFleetReceipt>,
  'admission'
> & {
  admission?: 'pending' | 'accepted'
}
export type StoredConversationFleetReceipt = z.output<typeof conversationFleetReceipt>

const sourceText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => Array.from(value).every((character) => character.charCodeAt(0) >= 32))
const sourceAssociation = z.object({
  session_ref: sourceText,
  session_id: sourceText.optional(),
  captured_at: z.string().datetime().optional()
})

/** Discovery is only a hint; the complete graph read establishes execution state. */
export function discoveredConversationFleetReceipts(
  jobs: readonly ConsoleJobRecord[],
  observedAt: string
): StoredConversationFleetReceipt[] {
  const candidates = new Map<string, StoredConversationFleetReceipt>()
  const rejected = new Set<string>()
  for (const job of jobs) {
    const workflow = job.policy.workflow
    const source = sourceAssociation.safeParse(workflow?.source)
    if (!workflow || workflow.placement === 'local' || !source.success) {
      continue
    }
    const parsed = conversationFleetReceipt.safeParse({
      workflowId: workflow.dispatch_id,
      taskId: workflow.source_task_id ?? job.task_id,
      rowKey: source.data.session_ref,
      sessionKey: source.data.session_id ?? null,
      title: job.title.slice(0, 500),
      createdAt: observedAt,
      capturedAt: source.data.captured_at,
      machine: workflow.machine ?? job.machine ?? null,
      digest: workflow.digest,
      admission: 'pending'
    })
    if (!parsed.success || rejected.has(workflow.dispatch_id)) {
      continue
    }
    const candidate = parsed.data
    const existing = candidates.get(candidate.workflowId)
    if (
      existing &&
      (existing.taskId !== candidate.taskId ||
        existing.rowKey !== candidate.rowKey ||
        existing.sessionKey !== candidate.sessionKey ||
        existing.capturedAt !== candidate.capturedAt ||
        existing.digest !== candidate.digest)
    ) {
      candidates.delete(candidate.workflowId)
      rejected.add(candidate.workflowId)
    } else if (!existing) {
      candidates.set(candidate.workflowId, candidate)
    }
  }
  return [...candidates.values()]
}

export function assertConversationFleetProgress(
  receipt: ConversationFleetReceipt,
  result: ConsoleWorkflowProgress
): void {
  if (result.workflow_id !== receipt.workflowId || !result.jobs.length) {
    throw new Error('The server has not verified this workflow admission.')
  }
  const sourceTaskId = result.jobs[0].policy.workflow.source_task_id
  if (
    result.jobs.some((job) => job.policy.workflow.source_task_id !== sourceTaskId) ||
    (sourceTaskId === undefined
      ? !result.jobs.some((job) => job.task_id === receipt.taskId)
      : sourceTaskId !== receipt.taskId)
  ) {
    throw new Error('The server returned a different workflow task.')
  }
  const digest = receipt.digest ?? result.jobs[0].policy.workflow.digest
  const ids = new Set<string>()
  const taskIds = new Set<string>()
  for (const job of result.jobs) {
    const workflow = job.policy.workflow
    if (
      ids.has(job.id) ||
      (sourceTaskId !== undefined && taskIds.has(job.task_id)) ||
      workflow.dispatch_id !== receipt.workflowId ||
      (workflow.workflow_id && workflow.workflow_id !== receipt.workflowId) ||
      workflow.digest !== digest ||
      workflow.placement === 'local' ||
      (workflow.source_task_id && workflow.source_task_id !== receipt.taskId)
    ) {
      throw new Error('The server returned a different workflow.')
    }
    ids.add(job.id)
    taskIds.add(job.task_id)
    const source = sourceAssociation.safeParse(workflow.source)
    if (
      !source.success ||
      source.data.session_ref !== receipt.rowKey ||
      (receipt.sessionKey && source.data.session_id !== receipt.sessionKey) ||
      (receipt.capturedAt && source.data.captured_at !== receipt.capturedAt)
    ) {
      throw new Error('The server returned a different conversation source.')
    }
  }
}

export function admittedConversationFleetJobs(
  receipt: ConversationFleetReceipt,
  jobs: ConsoleWorkflowJob[]
): ConsoleWorkflowJob[] {
  assertConversationFleetProgress(receipt, { workflow_id: receipt.workflowId, jobs })
  return jobs
}
