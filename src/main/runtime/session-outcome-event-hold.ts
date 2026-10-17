import { eventWaitAttention } from '../../shared/session-attention-drafts'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeEventSourceLabel,
  type SessionOutcomeWaitFact
} from '../../shared/session-outcome-event'
import type { SessionOutcome, SessionOutcomeCondition } from '../../shared/session-outcome-types'
import { WAIT_UNAVAILABLE_PREFIX } from './session-outcome-event-evidence'
import type { SessionOutcomeHoldReading } from './session-outcome-hold-block'

/** Block codes the row reads to phrase an event wait (`session-run-row-state.ts`). */
export const EVENT_WAIT_CODE = 'event-wait'
export const EVENT_WAIT_UNAVAILABLE_CODE = 'event-wait-unavailable'
export const EVENT_WAIT_NEEDS_YOU_CODE = 'event-wait-needs-you'

function who(condition: SessionOutcomeCondition, fact?: SessionOutcomeWaitFact): string {
  const event = condition.event
  if (event?.source === 'time') {
    return fact?.reason?.replace(/^Waiting /, '').replace(/\.$/, '') ?? 'a time'
  }
  if (event?.source === 'github') {
    const number = /\/pull\/(\d+)$/.exec(event.ref ?? '')?.[1]
    return `PR #${number ?? '?'} ${event.match === 'merged' ? 'to merge' : 'approval'}`
  }
  if (event?.source === 'session') {
    return condition.label ?? `session ${event.ref ?? '?'} to finish`
  }
  if (condition.kind === 'review') {
    return fact?.by ?? condition.recipientId ?? 'their review'
  }
  if (event?.source === 'signin') {
    return `${event.personName ?? event.personId} signs in to ${event.ref}`
  }
  return event?.personName ?? fact?.by ?? event?.personId ?? 'them'
}

/**
 * "Uma ✓, Iris ○ on Slack; PR #12 to merge ○; Billing session finishes ○": who each wait is on,
 * grouped by where the answer comes from, with a mark for each one that has already arrived.
 */
export function sessionOutcomeEventWake(outcome: SessionOutcome, proven: Set<string>): string {
  const groups = new Map<string, string[]>()
  for (const condition of outcome.conditions) {
    if (condition.kind !== 'event' || !condition.event) {
      continue
    }
    const fact = outcome.waits?.find((entry) => entry.conditionId === condition.id)
    const source = condition.event.source
    // Replies are "on Slack"; a time, a PR or a sign-in names itself.
    const place = ['slack', 'email', 'jira'].includes(source)
      ? ` ${sessionOutcomeEventSourceLabel(source)}`
      : ''
    const mark = proven.has(condition.id) ? '✓' : '○'
    groups.set(place, [...(groups.get(place) ?? []), `${who(condition, fact)} ${mark}`])
  }
  return [...groups]
    .map(([place, names]) => `${names.join(', ')}${place}`)
    .join('; ')
    .slice(0, 200)
}

/**
 * What an outcome still waiting on outside events is: the owner's decision when an answer came back
 * as something other than a yes (or a deadline passed); an honest "not scheduled" when nobody can
 * check; otherwise a wait on the named people, polled by the verifier.
 */
export function sessionOutcomeEventHold(
  chain: SessionChain,
  outcome: SessionOutcome,
  proven: Set<string>
): SessionOutcomeHoldReading | null {
  const unmet = outcome.conditions.filter(
    (condition) =>
      !proven.has(condition.id) &&
      (condition.kind === 'event' || (condition.kind === 'review' && condition.require))
  )
  const fact = (condition: SessionOutcomeCondition) =>
    outcome.waits?.find((entry) => entry.conditionId === condition.id)
  const asking = unmet.filter((condition) => fact(condition)?.status === 'needs_you')
  if (asking.length) {
    return {
      block: { class: 'attention', code: EVENT_WAIT_NEEDS_YOU_CODE },
      attention: asking.map((condition) =>
        eventWaitAttention({
          scope: {
            outcomeId: outcome.id,
            outcomeRevision: outcome.revision,
            ...(chain.planVersion ? { planVersion: chain.planVersion } : {}),
            conditionId: condition.id
          },
          person: who(condition, fact(condition)),
          place:
            condition.event && condition.event.source !== 'time'
              ? sessionOutcomeEventSourceLabel(condition.event.source)
              : '',
          reason: fact(condition)?.reason,
          excerpt: fact(condition)?.excerpt,
          paneKey: chain.sourcePaneKey
        })
      )
    }
  }
  const events = unmet.filter((condition) => condition.kind === 'event')
  if (!events.length) {
    return null
  }
  const down = events.map(fact).find((entry) => entry?.status === 'unavailable')
  if (down) {
    return {
      block: {
        class: 'waiting',
        code: EVENT_WAIT_UNAVAILABLE_CODE,
        wake: `${WAIT_UNAVAILABLE_PREFIX} ${down.reason ?? 'the source cannot be checked.'}`
      },
      attention: []
    }
  }
  return {
    block: {
      class: 'waiting',
      code: EVENT_WAIT_CODE,
      wake: sessionOutcomeEventWake(outcome, proven)
    },
    attention: []
  }
}
