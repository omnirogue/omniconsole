import { translate } from '@/i18n/i18n'
import {
  runSessionBulkAction,
  type SessionBulkOutcome
} from '@/components/sidebar/session-folders/session-bulk-outcome'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import {
  inboxSafeNextSteps,
  LIVE_INBOX_DEPS,
  refusalOutcome,
  type NextStepsInboxDeps,
  type NextStepsInboxRow
} from './next-steps-inbox'

/** One session's safe steps exactly as the review panel shows them. */
export type InboxRunPlanEntry = {
  key: string
  label: string
  setId: string
  steps: NextStepSuggestion[]
}

/** A session, or some of its steps, that "Run all safe" leaves to the person. */
export type InboxRunPlanNeedsYou = { key: string; label: string; reason: string; titles: string[] }

/**
 * What "Run all safe" would send, captured when the review opens. Only these set and suggestion
 * ids are ever sent, and only after the person confirms them.
 */
export type InboxRunPlan = {
  entries: InboxRunPlanEntry[]
  needsYou: InboxRunPlanNeedsYou[]
  /** How many prompts the confirm button sends. */
  count: number
}

export function buildInboxRunPlan(rows: readonly NextStepsInboxRow[]): InboxRunPlan {
  const entries: InboxRunPlanEntry[] = []
  const needsYou: InboxRunPlanNeedsYou[] = []
  for (const row of rows) {
    const base = { key: row.key, label: row.label }
    if (row.missing) {
      needsYou.push({
        ...base,
        reason: translate('nextStepsInbox.sessionNotFound', 'Session not found'),
        titles: []
      })
      continue
    }
    if (!row.set.suggestions.length) {
      needsYou.push({
        ...base,
        reason: translate('nextStepsInbox.noSuggestions', 'No suggestions.'),
        titles: []
      })
      continue
    }
    const safe = inboxSafeNextSteps(row.set)
    const safeIds = new Set(safe.map((step) => step.id))
    const risky = row.set.suggestions.filter((step) => !safeIds.has(step.id))
    if (safe.length) {
      entries.push({ ...base, setId: row.set.id, steps: safe })
    }
    if (risky.length) {
      needsYou.push({
        ...base,
        reason: translate('nextStepsInbox.riskyNeedsYou', 'Needs you: risky steps'),
        titles: risky.map((step) => step.title)
      })
    }
  }
  return { entries, needsYou, count: entries.reduce((sum, entry) => sum + entry.steps.length, 0) }
}

/** The reviewed steps are still exactly what the set offers, and still safe. */
function unchanged(entry: InboxRunPlanEntry, now: NextStepSuggestionSet | undefined): boolean {
  if (!now || now.id !== entry.setId || now.status !== 'pending') {
    return false
  }
  return entry.steps.every((step) => {
    const current = now.suggestions.find((candidate) => candidate.id === step.id)
    return (
      current !== undefined &&
      current.title === step.title &&
      current.prompt === step.prompt &&
      current.risk === 'safe'
    )
  })
}

/**
 * Sends the reviewed plan, one session after another. A session whose set changed, or is no
 * longer pending, since the review opened is skipped with the reason; nothing unseen is sent.
 */
export async function runInboxPlan(
  plan: InboxRunPlan,
  current: ReadonlyMap<string, NextStepSuggestionSet> | null,
  deps: NextStepsInboxDeps = LIVE_INBOX_DEPS
): Promise<SessionBulkOutcome[]> {
  const sent = await runSessionBulkAction(plan.entries, async (entry) => {
    if (!unchanged(entry, current?.get(entry.key))) {
      return {
        ok: false,
        message: translate(
          'nextStepsInbox.changedSinceReview',
          'Skipped: these suggestions changed or were answered after you reviewed them.'
        )
      }
    }
    try {
      const result = await deps.decide(entry.setId, {
        action: 'run',
        suggestionIds: entry.steps.map((step) => step.id)
      })
      const reasons = [...new Set(result.notQueued.map((item) => item.reason))].join(' ')
      if (!result.queued.length) {
        return {
          ok: false,
          message: reasons || translate('nextStepsInbox.nothingQueued', 'Nothing was queued.')
        }
      }
      return reasons
        ? {
            ok: true,
            message: translate('nextStepsInbox.someNotQueued', '{{n}} not queued: {{reason}}', {
              n: result.notQueued.length,
              reason: reasons
            })
          }
        : { ok: true }
    } catch (error) {
      return refusalOutcome(error)
    }
  })
  const planned = new Set(plan.entries.map((entry) => entry.key))
  // Sessions with nothing safe to send are still reported, never silently dropped.
  const leftToYou: SessionBulkOutcome[] = plan.needsYou
    .filter((item) => !planned.has(item.key))
    .map((item) => ({ key: item.key, label: item.label, ok: false, message: item.reason }))
  return [...sent, ...leftToYou]
}
