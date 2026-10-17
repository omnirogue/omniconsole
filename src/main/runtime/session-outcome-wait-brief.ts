import type { SessionChain } from '../../shared/session-chain-types'
import {
  SESSION_OUTCOME_WAIT_BRIEF_MARKER,
  sessionOutcomeEventSourceLabel
} from '../../shared/session-outcome-event'
import type { SessionOutcome, SessionOutcomeAction } from '../../shared/session-outcome-types'

/** Every outcome this one waits behind, nearest first, each once. */
function upstream(chain: SessionChain, outcome: SessionOutcome): SessionOutcome[] {
  const outcomes = chain.outcomeSet?.outcomes ?? []
  const seen = new Set<string>()
  const order: SessionOutcome[] = []
  const visit = (ids: readonly string[]) => {
    for (const id of ids) {
      const found = outcomes.find((entry) => entry.id === id)
      if (found && !seen.has(id)) {
        seen.add(id)
        order.push(found)
        visit(found.dependsOn)
      }
    }
  }
  visit(outcome.dependsOn)
  return order
}

/** One line per wait that cleared: who, where, when, their words and the link. */
function receiptLines(outcomes: readonly SessionOutcome[]): string[] {
  return outcomes.flatMap((outcome) =>
    outcome.conditions.flatMap((condition) => {
      if (condition.kind !== 'event' && !(condition.kind === 'review' && condition.require)) {
        return []
      }
      const fact = outcome.waits?.find((entry) => entry.conditionId === condition.id)
      const proof = outcome.evidence.find((entry) => entry.conditionId === condition.id)
      if (!proof) {
        return []
      }
      const event = condition.event
      const who = event?.personName ?? fact?.by ?? condition.label ?? condition.target
      const place =
        event && event.source !== 'time' ? ` ${sessionOutcomeEventSourceLabel(event.source)}` : ''
      const said = fact?.excerpt ? ` — "${fact.excerpt}"` : ''
      const when = fact?.at ? ` at ${new Date(fact.at).toISOString()}` : ''
      const link = fact?.link ? ` (${fact.link})` : ''
      const overridden = proof.receipt.startsWith('owner-continued:')
        ? ' — you chose to continue without it'
        : ''
      return [`- ${condition.label ?? `${who}${place}`}${when}${said}${link}${overridden}`]
    })
  )
}

/**
 * The turn a chat-filed plan sends back into its own conversation when its waits clear: what
 * arrived, with receipts, then the next step in the person's own words. The conversation already
 * holds the plan, so none of it is restated.
 */
export function sessionOutcomeWaitBrief(chain: SessionChain, action: SessionOutcomeAction): string {
  const outcome = chain.outcomeSet?.outcomes.find((entry) =>
    entry.actions.some((candidate) => candidate.id === action.id)
  )
  const receipts = outcome ? receiptLines(upstream(chain, outcome)) : []
  return [
    `${SESSION_OUTCOME_WAIT_BRIEF_MARKER} in this conversation.`,
    // Only a wait that actually cleared is announced as cleared.
    ...(receipts.length ? ['The wait has cleared. What arrived:', ...receipts] : []),
    // Quoted so no parser reads the person's old sentence as a new request.
    'Next, in the words of the person who asked:',
    ...action.instruction.split('\n').map((line) => `> ${line}`),
    'Do only this step now, with only the authority in their words; money, ads and customer rules still apply. Say what you did and any receipt. OmniConsole continues the plan (and closes or saves this session if they asked) once this turn ends.'
  ].join('\n')
}
