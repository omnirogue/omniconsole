import type { SessionChain } from './session-chain-types'
import type { SessionOutcomeCondition } from './session-outcome-types'

/** CONTRACT.md §3: one row of a session's waits as omnios shows it (≤20 per session). */
export type SessionWaitSummaryItem = {
  label: string
  source: 'slack' | 'email' | 'jira' | 'signin' | 'github' | 'time' | 'omnios' | 'session'
  status: 'met' | 'pending' | 'needs_you' | 'unavailable'
  checked_at: string
  person_id?: string
  link?: string
}

const MAX_WAITS = 20

function isWait(condition: SessionOutcomeCondition): boolean {
  return (
    (condition.kind === 'event' && Boolean(condition.event)) ||
    (condition.kind === 'review' && Boolean(condition.require))
  )
}

/** Whether a plan carries anything omnios should show as a wait. */
export function sessionOutcomeHasWaits(chain: SessionChain): boolean {
  return Boolean(chain.outcomeSet?.outcomes.some((outcome) => outcome.conditions.some(isWait)))
}

/** The list omnios shows for this session; a cancelled plan clears it. */
export function sessionOutcomeWaitsSummary(
  chain: SessionChain,
  now = Date.now()
): SessionWaitSummaryItem[] {
  if (chain.state === 'cancelled' || !chain.outcomeSet) {
    return []
  }
  return chain.outcomeSet.outcomes
    .flatMap((outcome) =>
      outcome.conditions.filter(isWait).map((condition): SessionWaitSummaryItem => {
        const fact = outcome.waits?.find((entry) => entry.conditionId === condition.id)
        const proven = outcome.evidence.some(
          (entry) =>
            entry.conditionId === condition.id && entry.outcomeRevision === outcome.revision
        )
        const event = condition.event
        const person =
          event?.personId ?? (condition.kind === 'review' ? condition.recipientId : undefined)
        const link = fact?.link ?? (event?.source === 'github' ? event.ref : undefined)
        return {
          label: (condition.label ?? condition.target).slice(0, 160),
          source: event?.source ?? 'omnios',
          status: proven ? 'met' : (fact?.status ?? 'pending'),
          checked_at: new Date(fact?.checkedAt ?? now).toISOString(),
          ...(person && /^emp_[A-Za-z0-9_-]{1,120}$/.test(person) ? { person_id: person } : {}),
          ...(link?.startsWith('https://') && link.length <= 500 ? { link } : {})
        }
      })
    )
    .slice(0, MAX_WAITS)
}

/** What makes a new write worth it: a wait added, removed, relabelled or changing status. */
export function sessionWaitsFingerprint(items: readonly SessionWaitSummaryItem[]): string {
  return JSON.stringify(items.map(({ checked_at: _checked, ...rest }) => rest))
}
