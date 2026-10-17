import type { SessionChain } from './session-chain-types'
import { sessionFollowUpDisposition } from './session-follow-up-rule'

/**
 * Where a plan leaves the work once its steps are through. Agents are never the end: the
 * work is ended (✓), owned by a person it was handed to, or back with the person who asked.
 */
export type SessionChainDestination =
  | { kind: 'done' }
  | { kind: 'person'; names: string }
  | { kind: 'me' }

/** A person who now owns the work ends the plan; nothing comes back and nothing is "finished" by us. */
export function endsWithOwnershipHandoff(chain: Pick<SessionChain, 'steps'>): boolean {
  const last = chain.steps.at(-1)
  return (
    last?.kind === 'handoff' && sessionFollowUpDisposition(last.handoff) === 'ownership-transfer'
  )
}

export function sessionChainDestination(
  chain: Pick<SessionChain, 'steps' | 'end'>
): SessionChainDestination {
  const last = chain.steps.at(-1)
  if (
    last?.kind === 'handoff' &&
    sessionFollowUpDisposition(last.handoff) === 'ownership-transfer'
  ) {
    return {
      kind: 'person',
      names: [...last.handoff.recipients, ...(last.handoff.agentRecipients ?? [])]
        .map((recipient) => recipient.name)
        .join(', ')
    }
  }
  return chain.end === 'me' ? { kind: 'me' } : { kind: 'done' }
}
