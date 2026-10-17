import type { Automation } from '../../shared/automations-types'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { describeScheduledRefusal } from './dispatch-refusal'
import type { AutomationRunWriter } from './automation-run-writer'

/**
 * How late an occurrence may start. The scheduler only looks once per tick, so an on-time
 * occurrence is always found up to a tick (plus a slow pass) after its minute; "No grace" means
 * "do not catch up after downtime", never "skip every occurrence the tick did not land on".
 */
export function effectiveMissedRunGraceMs(
  automation: Pick<Automation, 'missedRunGraceMinutes'>,
  tickMs: number
): number {
  return Math.max(automation.missedRunGraceMinutes * 60 * 1000, 2 * tickMs)
}

export type ScheduledOccurrenceDecision =
  /** No window can take the run yet; the occurrence stays due and is looked at next tick. */
  { kind: 'wait' } | { kind: 'missed' } | { kind: 'refused'; reason: string } | { kind: 'dispatch' }

/**
 * What the scheduler does with the latest due occurrence. A closed or still-attaching window is
 * the one refusal that clears on its own, so within grace the occurrence waits for it instead of
 * being skipped — skipping lost every run scheduled while the window was away.
 */
export function decideScheduledOccurrence(input: {
  lateMs: number
  graceMs: number
  target: AutomationRunTargetResult
  canDispatch: boolean
}): ScheduledOccurrenceDecision {
  const waitingForWindow = input.target.ok && !input.canDispatch
  if (waitingForWindow && input.lateMs <= input.graceMs) {
    return { kind: 'wait' }
  }
  // Why: a window that never came back is refused (and folded), not reported as downtime.
  if (!waitingForWindow && input.lateMs > input.graceMs) {
    return { kind: 'missed' }
  }
  const reason = describeScheduledRefusal({ target: input.target, canDispatch: input.canDispatch })
  return reason ? { kind: 'refused', reason } : { kind: 'dispatch' }
}

/** Logs each waiting occurrence once, not once per tick. */
export function createWaitingOccurrenceLog(): {
  waiting: (automationId: string, scheduledFor: number) => void
  settled: (automationId: string) => void
} {
  const logged = new Map<string, number>()
  return {
    waiting: (automationId, scheduledFor) => {
      if (logged.get(automationId) === scheduledFor) {
        return
      }
      logged.set(automationId, scheduledFor)
      console.info(
        '[automations] occurrence waiting for an OmniConsole window',
        automationId,
        new Date(scheduledFor).toISOString()
      )
    },
    settled: (automationId) => {
      logged.delete(automationId)
    }
  }
}

/**
 * Writes what a missed or refused occurrence leaves in run history. True when the occurrence is
 * settled here; false when it should be dispatched (a refusal that did not fold is dispatched
 * so the refusal is recorded on its own run row).
 */
export function settleScheduledOccurrence(
  runs: AutomationRunWriter,
  automation: Automation,
  scheduledFor: number,
  decision: Exclude<ScheduledOccurrenceDecision, { kind: 'wait' }>
): boolean {
  if (decision.kind === 'missed') {
    console.warn(
      '[automations] missed occurrence outside its grace window',
      automation.id,
      new Date(scheduledFor).toISOString()
    )
    const missed = runs.createRun(automation, scheduledFor)
    // An occurrence launched before downtime keeps its own outcome.
    if (missed.status !== 'pending') {
      return true
    }
    runs.updateRun({
      runId: missed.id,
      status: 'skipped_missed',
      workspaceId: automation.workspaceId,
      error: 'OmniConsole was unavailable during the missed-run grace window.'
    })
    return true
  }
  if (decision.kind === 'refused') {
    console.warn('[automations] scheduled occurrence refused', automation.id, decision.reason)
    return runs.repeatSkip(automation.id, decision.reason, scheduledFor) !== null
  }
  return false
}
