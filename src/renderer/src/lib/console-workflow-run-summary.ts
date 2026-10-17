import type { ConsoleJobRecord } from '../../../shared/console-workflow-task-types'
import type { ConsoleWorkflowJob } from '../../../shared/console-workflow-types'
import { layoutConsoleWorkflow } from './console-workflow-layout'

/**
 * Where a run stands, read off the graph projection the server sends. The hub's state
 * vocabulary is opaque here: a stage has passed when it says so in one of these words or
 * carries the graph's own `skipped` mark; everything else is still to come.
 */
const FINISHED_STATES: ReadonlySet<string> = new Set(['done', 'completed', 'complete', 'skipped'])

export type WorkflowRunStage = {
  /** 1-based position in the after-order. */
  index: number
  key: string
  title: string
  state: string
  blockers: readonly string[]
  machine: string | null
  prUrl: string | null
}

export type WorkflowRunSummary = {
  total: number
  finished: number
  /** The first stage in after-order that has not passed; null once every stage has. */
  current: WorkflowRunStage | null
}

export type RunWorkflow = { id: string; updatedAt: string | null }

function stageFinished(job: ConsoleWorkflowJob): boolean {
  return (
    Boolean(job.policy.workflow.skipped) ||
    FINISHED_STATES.has(job.workflow_state.trim().toLowerCase())
  )
}

function inAfterOrder(jobs: readonly ConsoleWorkflowJob[]): ConsoleWorkflowJob[] {
  const keyOfId = new Map(jobs.map((job) => [job.id, job.policy.workflow.key]))
  const byKey = new Map(jobs.map((job) => [job.policy.workflow.key, job]))
  const layout = layoutConsoleWorkflow(
    jobs.map((job) => ({
      key: job.policy.workflow.key,
      after: job.policy.workflow.after.map((id) => keyOfId.get(id) ?? id)
    }))
  )
  // Why: a graph the layout refuses (a cycle, a missing stage) still reads in the order it came.
  if (!layout.ok) {
    return [...jobs]
  }
  return layout.columns.flat().flatMap((key) => {
    const job = byKey.get(key)
    return job ? [job] : []
  })
}

export function describeWorkflowRun(
  jobs: readonly ConsoleWorkflowJob[]
): WorkflowRunSummary | null {
  if (jobs.length === 0) {
    return null
  }
  const ordered = inAfterOrder(jobs)
  const finished = ordered.filter(stageFinished).length
  const position = ordered.findIndex((job) => !stageFinished(job))
  const job = position === -1 ? null : ordered[position]
  return {
    total: ordered.length,
    finished,
    current: job
      ? {
          index: position + 1,
          key: job.policy.workflow.key,
          title: job.title,
          state: job.workflow_state,
          blockers: job.blockers,
          machine: job.machine,
          prUrl: job.pr_url
        }
      : null
  }
}

/** The distinct workflows a card's stored jobs belong to, freshest first; a card admitted twice has two. */
export function workflowsOfJobs(jobs: readonly ConsoleJobRecord[]): RunWorkflow[] {
  const latest = new Map<string, string | null>()
  for (const job of jobs) {
    const workflow = job.policy.workflow
    const id = workflow?.workflow_id ?? workflow?.dispatch_id
    if (!id) {
      continue
    }
    const updatedAt = job.updated_at ?? null
    const known = latest.get(id)
    if (!latest.has(id) || (updatedAt && (!known || updatedAt > known))) {
      latest.set(id, updatedAt)
    }
  }
  return [...latest]
    .map(([id, updatedAt]) => ({ id, updatedAt }))
    .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
}
