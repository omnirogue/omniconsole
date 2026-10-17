import type { ConsoleWorkflowJob } from '../../../shared/console-workflow-types'
import { workflowWebLink } from './console-workflow-client'

export type ConversationFleetPhase =
  | 'working'
  | 'waiting'
  | 'needs-you'
  | 'failed'
  | 'complete'
  | 'cancelled'
  | 'unverifiable'

export type ConversationFleetProgress = {
  phase: ConversationFleetPhase
  completed: number
  total: number
  machines: string[]
  reviewUrls: string[]
}

const COMPLETED = new Set(['done', 'completed', 'merged', 'skipped'])
// A stopped stage is an honest failure someone may retry; it asks nothing of the person.
const FAILED = new Set(['failed', 'rejected'])
// A review someone else owes is a wait, not a row the person can act on.
const ACTIVE = new Set([
  'queued',
  'ready',
  'running',
  'claimed',
  'blocked',
  'waiting',
  'pr_open',
  'awaiting_review'
])
const SETTLED = new Set([...COMPLETED, ...FAILED, 'cancelled', 'cancel_requested'])

export type ConversationFleetPersonActions = {
  /** Stages the server has opened for this person's decision; the details dialog carries the form. */
  decisions: ConsoleWorkflowJob[]
  /** Reviews open on a stopped stage, one link each; a PR from a settled or still-running stage asks nothing yet. */
  reviewUrls: string[]
}

/**
 * What the person can do about a run from its details. Needs you lists a run only when this is
 * not empty (Sal, 2026-09-26): a status that says "needs a human" without a form or a link to act
 * on is someone else's wait, never a row the person cannot click.
 */
export function fleetRunPersonActions(
  jobs: readonly ConsoleWorkflowJob[]
): ConversationFleetPersonActions {
  return {
    decisions: jobs.filter((job) => job.can_decide === true),
    reviewUrls: [
      ...new Set(
        jobs.flatMap((job) =>
          workflowWebLink(job.pr_url) && !SETTLED.has(job.status) && job.status !== 'running'
            ? [job.pr_url!]
            : []
        )
      )
    ]
  }
}

export function fleetRunHasPersonActions(jobs: readonly ConsoleWorkflowJob[]): boolean {
  const actions = fleetRunPersonActions(jobs)
  return actions.decisions.length > 0 || actions.reviewUrls.length > 0
}

/** A lost read never turns a remote process into a completed job. */
export function conversationFleetProgress(
  jobs: readonly ConsoleWorkflowJob[],
  verified: boolean
): ConversationFleetProgress {
  const completed = jobs.filter((job) => COMPLETED.has(job.status)).length
  const result = {
    completed,
    total: jobs.length,
    machines: [...new Set(jobs.flatMap((job) => (job.machine ? [job.machine] : [])))],
    reviewUrls: [...new Set(jobs.flatMap((job) => (job.pr_url ? [job.pr_url] : [])))]
  }
  if (!verified || !jobs.length) {
    return { ...result, phase: 'unverifiable' }
  }
  if (jobs.some((job) => job.status === 'cancelled' || job.status === 'cancel_requested')) {
    return { ...result, phase: 'unverifiable' }
  }
  if (jobs.some((job) => job.status === 'running' && !job.can_decide)) {
    return { ...result, phase: 'working' }
  }
  if (fleetRunHasPersonActions(jobs)) {
    return { ...result, phase: 'needs-you' }
  }
  if (jobs.some((job) => FAILED.has(job.status))) {
    return { ...result, phase: 'failed' }
  }
  if (completed === jobs.length) {
    return { ...result, phase: 'complete' }
  }
  const known = jobs.every((job) => COMPLETED.has(job.status) || ACTIVE.has(job.status))
  return { ...result, phase: known ? 'waiting' : 'unverifiable' }
}

// The console's live statuses: exactly what its workflow cancel stops.
const LIVE = new Set(['queued', 'running', 'reviewing', 'paused', 'pr_open', 'qa', 'revision'])
const STOPPED = new Set(['failed', 'cancelled'])

/** Nothing more runs on the fleet unless someone retries it. */
export function conversationFleetSettled(phase: ConversationFleetPhase): boolean {
  return phase === 'complete'
}

export function cancellableFleetJobs(jobs: readonly ConsoleWorkflowJob[]): ConsoleWorkflowJob[] {
  return jobs.filter((job) => LIVE.has(job.status))
}

export function fleetJobPredecessors(job: ConsoleWorkflowJob): readonly string[] {
  // Why: a receipt restored before its first graph read can carry jobs without their policy.
  return job.policy?.workflow?.after ?? []
}

/** Stopped stages, earliest first, so each retry follows the predecessors it waits on. */
export function retryableFleetJobs(jobs: readonly ConsoleWorkflowJob[]): ConsoleWorkflowJob[] {
  const pending = new Map(jobs.filter((job) => STOPPED.has(job.status)).map((job) => [job.id, job]))
  const ordered: ConsoleWorkflowJob[] = []
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((job) =>
      fleetJobPredecessors(job).every((id) => !pending.has(id))
    )
    if (ready.length === 0) {
      break
    }
    for (const job of ready) {
      ordered.push(job)
      pending.delete(job.id)
    }
  }
  return ordered
}
