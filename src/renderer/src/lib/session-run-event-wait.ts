import { translate } from '@/i18n/i18n'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  SESSION_OUTCOME_WAIT_UNAVAILABLE_PREFIX,
  type SessionOutcomeWaitFact
} from '../../../shared/session-outcome-event'
import type { SessionOutcome } from '../../../shared/session-outcome-types'

export const WAIT_UNAVAILABLE_PREFIX = SESSION_OUTCOME_WAIT_UNAVAILABLE_PREFIX

/** A receipt counts only under the outcome's current revision. */
export function outcomeConditionProven(outcome: SessionOutcome, conditionId: string): boolean {
  return outcome.evidence.some(
    (receipt) => receipt.conditionId === conditionId && receipt.outcomeRevision === outcome.revision
  )
}

/** The latest readings of every event wait still unproven, across the chain's outcomes. */
export function unmetEventWaitFacts(chain: SessionChain): SessionOutcomeWaitFact[] {
  return (chain.outcomeSet?.outcomes ?? []).flatMap((outcome) =>
    (outcome.waits ?? []).filter(
      (fact) =>
        outcome.conditions.some((condition) => condition.id === fact.conditionId) &&
        !outcomeConditionProven(outcome, fact.conditionId)
    )
  )
}

/** "just now", "20 s ago", "3 min ago", "2 h ago". */
export function checkedAgoLabel(checkedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000))
  if (seconds < 5) {
    return translate('conversations.checkedJustNow', 'just now')
  }
  if (seconds < 60) {
    return translate('conversations.checkedSecondsAgo', '{{count}} s ago', { count: seconds })
  }
  if (seconds < 3600) {
    return translate('conversations.checkedMinutesAgo', '{{count}} min ago', {
      count: Math.floor(seconds / 60)
    })
  }
  return translate('conversations.checkedHoursAgo', '{{count}} h ago', {
    count: Math.floor(seconds / 3600)
  })
}

/** The waiting row's line for an event wait, or null when the run waits on something else. */
export function eventWaitHeadline(
  chain: SessionChain,
  wake: string | undefined,
  now: number
): string | null {
  if (wake?.startsWith(WAIT_UNAVAILABLE_PREFIX)) {
    return wake
  }
  const facts = unmetEventWaitFacts(chain)
  if (!wake || !facts.length) {
    return null
  }
  const newest = Math.max(...facts.map((fact) => fact.checkedAt))
  return translate('conversations.runWaitingEvent', 'Waiting · {{wake}} · checked {{ago}}', {
    wake,
    ago: checkedAgoLabel(newest, now)
  })
}
