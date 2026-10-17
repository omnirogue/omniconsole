import type { ConsoleWorkflowJob } from '../../shared/console-workflow-types'
import {
  isConsoleAutoAdvanceFolderWorkspace,
  isConsoleAutoAdvanceWorktree,
  type ConsoleAutoAdvanceStopReason
} from '../../shared/console-auto-advance'

export type ConsoleAutoAdvanceDecision =
  | { action: 'activate'; jobId: string; digest: string }
  | { action: 'wait'; jobId: string | null }
  | { action: 'stop'; reason: ConsoleAutoAdvanceStopReason; jobId: string | null }

export type ConsoleAutoAdvanceInput = {
  workflowId: string
  enabled: boolean
  worktree: string
  jobs: readonly ConsoleWorkflowJob[]
  /** Jobs this runner already activated; a second activation is never attempted. */
  activated: ReadonlySet<string>
}

/** The server's own queued/ready pair; anything else has already started or finished. */
function isReady(job: ConsoleWorkflowJob): boolean {
  return (
    job.workflow_state === 'ready' &&
    job.status === 'queued' &&
    job.blockers.length === 0 &&
    !job.policy.workflow.skipped
  )
}

function isLocal(job: ConsoleWorkflowJob): boolean {
  return job.policy.workflow.placement === 'local'
}

function belongsToWorkflow(job: ConsoleWorkflowJob, workflowId: string): boolean {
  const declared = job.policy.workflow.workflow_id
  return declared === undefined || declared === workflowId
}

/** A row the person has to decide, whether or not it is the next one in graph order. */
function awaitsPerson(job: ConsoleWorkflowJob): boolean {
  return job.can_decide === true || (job.actor_type === 'human' && isReady(job))
}

function isSettled(job: ConsoleWorkflowJob): boolean {
  return (
    !!job.policy.workflow.skipped ||
    ['done', 'complete', 'merged', 'failed', 'cancelled', 'rejected', 'skipped'].includes(
      job.workflow_state
    )
  )
}

/**
 * One cycle of the admitted graph: activate at most one ready local AI job, stop at anything a
 * person or the fleet owns, and otherwise keep waiting. Never selects a job that is not exactly
 * ready, is placed elsewhere, or was already activated by this runner.
 */
export function decideConsoleAutoAdvance(
  input: ConsoleAutoAdvanceInput
): ConsoleAutoAdvanceDecision {
  if (!input.enabled) {
    return { action: 'stop', reason: 'turned_off', jobId: null }
  }
  if (!isConsoleAutoAdvanceWorktree(input.worktree)) {
    return { action: 'stop', reason: 'no_workspace', jobId: null }
  }
  if (isConsoleAutoAdvanceFolderWorkspace(input.worktree)) {
    return { action: 'stop', reason: 'folder_workspace', jobId: null }
  }
  const jobs = input.jobs.filter((job) => belongsToWorkflow(job, input.workflowId))
  const decision = jobs.find(awaitsPerson)
  if (decision) {
    return { action: 'stop', reason: 'human_decision', jobId: decision.id }
  }
  const ready = jobs.filter((job) => isReady(job) && !input.activated.has(job.id))
  const next = ready.find((job) => isLocal(job) && job.actor_type === 'ai')
  if (next) {
    return { action: 'activate', jobId: next.id, digest: next.policy.workflow.digest }
  }
  if (ready.length) {
    return { action: 'stop', reason: 'fleet_placement', jobId: ready[0]!.id }
  }
  if (jobs.length && jobs.every(isSettled)) {
    return { action: 'stop', reason: 'workflow_complete', jobId: null }
  }
  return { action: 'wait', jobId: jobs.find((job) => !isSettled(job))?.id ?? null }
}
