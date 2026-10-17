/**
 * Workflow conversations in session management (C6). A Council, Discover, Evolve or Build + Review
 * conversation is a tab with no pane: its state is the record its controller keeps of the run,
 * never a terminal's. Each is observed and classified by that evidence before any pane fallback:
 * a draft or a Start in flight and a running or waiting run are kept; a verified finished run
 * follows ordinary tidy, and archiving or deleting its anchor keeps the run's history and cancels
 * nothing; "run not found" and "status unavailable" stay unverifiable and go only with
 * --delete --unverified. Nothing here ever reads a missing pane as a pending launch.
 */

import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type {
  SessionExecutionVerdict,
  SessionManageEntry,
  SessionStateBasis,
  SessionTidyGroup
} from '../../shared/session-manage-types'
import {
  sessionWorkflowAnchorRef,
  type SessionManageWorkflowAnchor,
  type SessionWorkflowAnchorRef,
  type WorkflowRunState
} from '../../shared/session-workflow-anchor'
import type { SessionAgentActivity } from './session-manage-state'
import type { SessionTidyVerdict } from './session-manage-tidy'
import { TIDY_DELETE_RECENT_MS } from './session-manage-tidy-delete'

export type SessionWorkflowRunReading =
  | { status: WorkflowRunState }
  | { status: 'missing' | 'unavailable'; reason?: string }

/** Reads the run from the controller that owns it, now: the revalidation before any removal. */
export type SessionWorkflowRunReader = (
  row: SessionManageSidebarRow,
  ref: SessionWorkflowAnchorRef
) => Promise<SessionWorkflowRunReading>

export type SessionWorkflowObservation = {
  verdict: SessionExecutionVerdict
  reason?: string
  activity?: SessionAgentActivity
  basis?: SessionStateBasis
  /** The anchor with the state just observed (the controller's when it was read). */
  anchor: SessionManageWorkflowAnchor
}

const FINISHED_WORDS = { done: 'completed', failed: 'failed', stopped: 'was stopped' } as const

/**
 * Without a controller reader, what the window last read is all this host has. It may still
 * protect a run (running, waiting on the person) but never prove one finished: a cached finish is
 * not revalidated, so it stays unverifiable and goes only with --delete --unverified.
 */
function windowReading(anchor: SessionManageWorkflowAnchor): SessionWorkflowRunReading {
  switch (anchor.status) {
    case 'running':
    case 'needs-you':
    case 'missing':
      return { status: anchor.status }
    case 'done':
    case 'failed':
    case 'stopped':
      return {
        status: 'unavailable',
        reason: 'its controller was not asked; the window last saw it finish'
      }
    case 'unavailable':
      return { status: 'unavailable' }
    case 'draft':
    case 'starting':
    case 'unknown':
      return { status: 'unavailable', reason: 'the window has not read it yet' }
  }
}

export async function observeWorkflowAnchor(
  row: SessionManageSidebarRow,
  anchor: SessionManageWorkflowAnchor,
  read: SessionWorkflowRunReader | undefined
): Promise<SessionWorkflowObservation> {
  const ref = sessionWorkflowAnchorRef(anchor)
  if (!ref) {
    return anchor.status === 'starting'
      ? {
          verdict: 'live',
          activity: { kind: 'working', activity: 'Its workflow Start is still being sent.' },
          basis: 'workflow',
          anchor
        }
      : {
          verdict: 'live',
          activity: { kind: 'unknown', reason: 'A workflow draft that has not been started.' },
          anchor
        }
  }
  let reading: SessionWorkflowRunReading
  try {
    reading = read ? await read(row, ref) : windowReading(anchor)
  } catch (error) {
    reading = { status: 'unavailable', reason: error instanceof Error ? error.message : '' }
  }
  const observed = { ...anchor, status: reading.status }
  const detail = 'reason' in reading && reading.reason ? ` (${reading.reason})` : ''
  switch (reading.status) {
    case 'running':
      return {
        verdict: 'live',
        activity: { kind: 'working', activity: 'Its workflow run is running.' },
        basis: 'workflow',
        anchor: observed
      }
    case 'needs-you':
      return {
        verdict: 'live',
        activity: {
          kind: 'question',
          prompt:
            'its workflow run is waiting on you (paused, out of budget, needing recovery or a worker’s question)'
        },
        basis: 'workflow',
        anchor: observed
      }
    case 'done':
    case 'failed':
    case 'stopped':
      return {
        verdict: 'exited',
        reason: `Its workflow run ${FINISHED_WORDS[reading.status]}; its run history is kept.`,
        basis: 'workflow',
        anchor: observed
      }
    case 'missing':
      return {
        verdict: 'unverifiable',
        reason: `Run not found: the controller that started it has no run ${ref.runId}${detail}, so it cannot be verified; that is never read as done.`,
        anchor: observed
      }
    case 'unavailable':
      return {
        verdict: 'unverifiable',
        reason: `Status unavailable: its workflow run could not be read${detail}; that is never read as done.`,
        anchor: observed
      }
  }
}

/** A workflow row's observation, or null for any other row; a quarantined row is never read. */
export function observeWorkflowRow(
  row: SessionManageSidebarRow,
  read: SessionWorkflowRunReader | undefined
): Promise<SessionWorkflowObservation | null> {
  return row.workflow && !row.ownershipUnverified
    ? observeWorkflowAnchor(row, row.workflow, read)
    : Promise.resolve(null)
}

type WorkflowTidyRowInput = Pick<SessionManageSidebarRow, 'workflow' | 'routine'>

/**
 * Where a workflow conversation lands in `omni session tidy`, or null for any other row. Ordinary
 * tidy and `--delete` read the same run evidence; only the verbs differ.
 */
export function classifyWorkflowSessionTidy(
  row: WorkflowTidyRowInput,
  entry: SessionManageEntry,
  hold: string | null,
  include: ReadonlySet<string>,
  mode: { delete: boolean; unverified: boolean; now: number }
): SessionTidyVerdict | null {
  const anchor = entry.workflow ?? row.workflow
  if (!row.workflow || !anchor) {
    return null
  }
  const key = entry.paneKey ?? entry.tabId
  const named = key !== null && include.has(key)
  const keep = (group: SessionTidyGroup, reason: string): SessionTidyVerdict =>
    group === 'held' ? { action: 'hold', reason, group } : { action: 'skip', reason, group }
  const act = (reason: string, extra: Partial<SessionTidyVerdict> = {}): SessionTidyVerdict =>
    mode.delete
      ? {
          action: 'delete',
          reason: named ? `${reason} The request names it.` : reason,
          ...(named ? { included: true as const } : {}),
          ...extra
        }
      : { action: 'archive', reason, ...extra }
  if (!mode.delete && entry.archived) {
    return keep('already-archived', 'Already archived.')
  }
  if (!anchor.runId) {
    return keep('workflow-draft', entry.waitingOn ?? 'Its workflow has not been started.')
  }
  if (entry.state === 'working' || entry.state === 'awaiting-user') {
    const what = entry.state === 'working' ? 'is running' : 'is waiting on the person'
    return keep('workflow-active', `Its workflow run ${what}; tidy never cancels a run.`)
  }
  const lifted = mode.delete && named
  if (entry.pinned && !lifted) {
    return keep('pinned', 'Pinned.')
  }
  if (entry.saved && !lifted) {
    return keep('saved', `Saved${entry.folder ? ` (${entry.folder})` : ''}.`)
  }
  if (mode.delete && row.routine && !named) {
    return keep('routine', 'A routine runs in it.')
  }
  if (hold && !named) {
    return keep('held', hold)
  }
  const heldButNamed = hold ? `Held (${hold}) but the request names it. ` : ''
  if (entry.verdict === 'unverifiable' || entry.state === 'unknown') {
    const group =
      anchor.status === 'missing' ? 'workflow-run-not-found' : 'workflow-status-unavailable'
    const why = entry.waitingOn ?? 'Its workflow run could not be verified.'
    if (!mode.delete || !mode.unverified) {
      return keep(group, `${why} It is kept; only tidy --delete --unverified removes it.`)
    }
    const recent =
      entry.lastActivityAt !== null && mode.now - entry.lastActivityAt < TIDY_DELETE_RECENT_MS
    if (recent && !named) {
      return keep(group, `${why} It was active in the last hour and may still be restoring.`)
    }
    return act(
      `${heldButNamed}${why} Deleting closes its tab here, keeps the run’s history and cancels nothing.`,
      { unverified: true }
    )
  }
  if (entry.state === 'exited') {
    const done = entry.waitingOn ?? 'Its workflow run finished.'
    return act(
      `${heldButNamed}${done} ${mode.delete ? 'Deleting closes its tab' : 'Archiving'} cancels nothing.`,
      hold && !mode.delete ? { included: true } : {}
    )
  }
  return keep('unknown-state', 'Its workflow state is unknown; unknown means keep.')
}

/** Why `omni session delete` refuses a workflow conversation, or null when it may go. */
export function sessionWorkflowDeleteRefusal(
  entry: SessionManageEntry,
  options: { force: boolean; unverified: boolean }
): string | null {
  const name = `“${entry.title}”`
  if ((entry.state === 'working' || entry.state === 'awaiting-user') && !options.force) {
    const what = entry.state === 'working' ? 'still running' : 'waiting on the person'
    return `${name} is a workflow whose run is ${what}. Deleting closes its tab and cancels nothing; pass --force to delete it anyway.`
  }
  if ((entry.verdict === 'unverifiable' || entry.state === 'unknown') && !options.unverified) {
    return `${name} cannot be verified (${entry.waitingOn ?? 'its workflow state is unknown'}), so it was not deleted. When the person asks, delete it with --unverified (its tab closes; the run’s history is kept and nothing is cancelled).`
  }
  return null
}
