/**
 * The target's latest turn as `continue` checks it: its reply, whether that reply is whole, and
 * its own proposal, taken in ONE synchronous snapshot of the next-steps host's memory after the
 * only await, so what is returned, and hashed into the fence, is a single revision. A turn that
 * moved during the await reads as unread.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import type { NextStepSuggestionService } from '../next-steps/next-step-suggestion-service'
import { currentNextStepTurn, nextStepTurnSets } from '../next-steps/next-step-turn-answers'
import { UNREAD_TURN, type SessionLatestTurn } from './session-manage-freeform'

/** The host itself positively knows this conversation never produced a turn (not merely unread). */
export type ConversationNeverReplied = (source: ConversationSource) => boolean

function neverRepliedSafely(neverReplied: ConversationNeverReplied, source: ConversationSource) {
  try {
    return neverReplied(source)
  } catch {
    return false
  }
}

/** Synchronous: what the host holds in memory right now. */
export function snapshotLatestTurn(
  service: NextStepSuggestionService,
  source: ConversationSource,
  neverReplied: ConversationNeverReplied
): SessionLatestTurn {
  const key = conversationSourceRowKey(source)
  const observed = service.currentTurns.get(key) ?? null
  if (!observed) {
    const anySet = service.deps.store
      .list()
      .some((set) => set.conversation && conversationSourceRowKey(set.conversation) === key)
    return {
      ...UNREAD_TURN,
      known: true,
      empty: !anySet && neverRepliedSafely(neverReplied, source)
    }
  }
  // Why the newest report of the same turn: a turn re-reported with other words is those words.
  const latest = service.latestTurns.get(key)
  const reply = latest?.turnKey === observed.turnKey ? latest : observed.turn
  const parsed = nextStepTurnSets(service, key, observed.turnKey)
    .filter((set) => set.origin === 'parsed')
    .toSorted((left, right) => right.createdAt - left.createdAt)[0]
  const proposal = parsed?.suggestions.map(({ id, title, prompt, why }) => [
    id,
    title,
    prompt,
    why ?? null
  ])
  return {
    known: true,
    turnKey: observed.turnKey,
    text: reply?.lastAssistantMessage ?? null,
    complete: reply?.replyComplete === true,
    proposal: proposal?.length ? JSON.stringify(proposal) : null,
    empty: false
  }
}

export async function readLatestTurn(
  service: NextStepSuggestionService,
  source: ConversationSource,
  neverReplied: ConversationNeverReplied
): Promise<SessionLatestTurn> {
  const { observed, known } = await currentNextStepTurn(service, source)
  if (!known) {
    return UNREAD_TURN
  }
  const snapshot = snapshotLatestTurn(service, source, neverReplied)
  // Why re-read after the await: the turn it read must still be the one in memory.
  return snapshot.turnKey === (observed?.turnKey ?? null) ? snapshot : UNREAD_TURN
}
