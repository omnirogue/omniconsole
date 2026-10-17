import { isFinalAutomationRunStatus } from '../../../../shared/automation-run-status'
import type { AutomationAction } from '../../../../shared/automation-actions'
import type { AutomationRun } from '../../../../shared/automations-types'
import { getAutomationRunMessage } from './automation-run-content'

/** What the apply run says happened to one action, as far as its record shows. */
export type AutomationApplyOutcome =
  | { state: 'verifying'; runNumber: number | null }
  | { state: 'applied'; runNumber: number | null }
  | { state: 'failed'; runNumber: number | null; reason: string }
  | { state: 'unknown'; runNumber: number | null }

const FAILURE_PROSE = /\b(refused|could not|couldn't|unable to|failed|not applied|declined)\b/i
const MAX_REASON_CHARS = 120

function shortReason(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_REASON_CHARS ? `${oneLine.slice(0, MAX_REASON_CHARS - 1)}…` : oneLine
}

/**
 * Apply runs are found by the `· apply <ids>` title suffix so the sent state survives
 * reloads (PR #460); the outcome then comes from that run's status and message. Nothing
 * here ever surfaces ids, JSON or screen text: only a state and a short reason.
 */
export function readAutomationApplyOutcomes(
  report: Pick<AutomationRun, 'automationId' | 'createdAt'>,
  runs: readonly AutomationRun[],
  actions: readonly AutomationAction[]
): Map<string, AutomationApplyOutcome> {
  const outcomes = new Map<string, AutomationApplyOutcome>()
  const ids = new Set(actions.map((action) => action.id))
  const later = runs
    .filter((run) => run.automationId === report.automationId && run.createdAt > report.createdAt)
    .sort((left, right) => left.createdAt - right.createdAt)
  for (const run of later) {
    const marker = run.title.lastIndexOf('· apply ')
    if (marker === -1) {
      continue
    }
    const outcome = outcomeOfRun(run)
    for (const raw of run.title.slice(marker + '· apply '.length).split(',')) {
      const id = raw.trim()
      if (ids.has(id)) {
        outcomes.set(id, outcome)
      }
    }
  }
  return outcomes
}

function outcomeOfRun(run: AutomationRun): AutomationApplyOutcome {
  const runNumber = run.runNumber ?? null
  if (!isFinalAutomationRunStatus(run.status)) {
    return { state: 'verifying', runNumber }
  }
  if (run.status !== 'completed') {
    return {
      state: 'failed',
      runNumber,
      reason: shortReason(run.error ?? 'The apply run did not finish.')
    }
  }
  const message = getAutomationRunMessage(run)
  if (message.scraped) {
    return { state: 'unknown', runNumber }
  }
  if (FAILURE_PROSE.test(message.text) && !/\b(PAUSED|ACTIVE)\b/.test(message.text)) {
    return { state: 'failed', runNumber, reason: shortReason(message.text.split('\n')[0] ?? '') }
  }
  return { state: 'applied', runNumber }
}
