import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { AutomationRunWriter } from './automation-run-writer'

/** Fixed so successive overlapping occurrences fold into one history row. */
export const ROUTINE_RUN_IN_PROGRESS =
  'The previous run of this routine was still in progress, so this occurrence was skipped.'

// Why not `pending`: nothing has launched yet, and a row left pending by an older build
// would otherwise block the routine forever.
const ACTIVE_RUN_STATUSES: ReadonlySet<AutomationRun['status']> = new Set([
  'dispatching',
  'dispatched'
])

export function isActiveAutomationRun(run: AutomationRun): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status)
}

/** A routine owns at most one live session; its newest unfinished run is that session. */
export function findActiveAutomationRun(
  runs: readonly AutomationRun[],
  exceptRunId?: string
): AutomationRun | null {
  return (
    runs
      .filter((run) => run.id !== exceptRunId && isActiveAutomationRun(run))
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  )
}

/**
 * Dispatches a due occurrence unless it was already launched (before a crash or quit)
 * or the routine's previous run still holds its session; neither may start a second agent.
 */
export function dispatchScheduledOccurrence(input: {
  automation: Automation
  scheduledFor: number
  history: readonly AutomationRun[]
  runs: AutomationRunWriter
  /** False when the dispatch will be refused anyway; that refusal is the truer row. */
  launchable: boolean
  dispatch: (run: AutomationRun) => Promise<AutomationRun>
}): Promise<AutomationRun> {
  const { automation, scheduledFor, history, runs } = input
  const existing = history.find((run) => run.scheduledFor === scheduledFor)
  if (existing && existing.status !== 'pending') {
    return Promise.resolve(existing)
  }
  if (input.launchable && findActiveAutomationRun(history, existing?.id)) {
    const folded = runs.repeatSkip(automation.id, ROUTINE_RUN_IN_PROGRESS, scheduledFor)
    return Promise.resolve(
      folded ??
        runs.updateRun({
          runId: (existing ?? runs.createRun(automation, scheduledFor)).id,
          status: 'skipped_unavailable',
          workspaceId: automation.workspaceId,
          error: ROUTINE_RUN_IN_PROGRESS
        })
    )
  }
  // Returned, not awaited, so dispatch keeps the scheduler's existing microtask order.
  return input.dispatch(existing ?? runs.createRun(automation, scheduledFor))
}

/**
 * Runs handed to the current renderer incarnation. A reload keeps the window (so
 * setWebContents never fires) but drops every in-flight dispatch handler, so the
 * runs still `dispatching` then have nobody to finish them.
 */
export function createRendererDispatchLedger(): {
  sent: (runId: string) => void
  /** Clears the ledger; returns the runs the previous incarnation left `dispatching`. */
  takeAbandoned: (runs: readonly AutomationRun[]) => AutomationRun[]
} {
  const sent = new Set<string>()
  return {
    sent: (runId) => void sent.add(runId),
    takeAbandoned: (runs) => {
      const abandoned = runs.filter((run) => sent.has(run.id) && run.status === 'dispatching')
      sent.clear()
      return abandoned
    }
  }
}
