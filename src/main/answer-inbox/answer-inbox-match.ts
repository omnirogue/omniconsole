/**
 * Which hook may carry or confirm which answer: the same conversation (ids from the payload), in
 * the pane that holds it, from the launch (and, when known, the agent process) recorded for that
 * pane when the answer was handed over. An answer waiting for a resume is bound to the pane and
 * launch that resume opened before any hook may take it. A caller holding the shared hook token
 * gets nothing.
 */

import type { AnswerItem, AnswerTakeEvent, HookConversation, HolderIdentity } from './answer-inbox'

/**
 * One repeat budget per answer, shared with the typed path: it goes out by hook at most once, and
 * any further attempt (unacknowledged, or acknowledged but never confirmed) is the one typed copy.
 */
export const ANSWER_MAX_HOOK_COPIES = 1

export function conversationMatches(item: AnswerItem, hook: HookConversation): boolean {
  if (item.conversation.provider !== hook.provider) {
    return false
  }
  const id = item.conversation.sessionId.toLowerCase()
  return hook.ids.some((candidate) => candidate.toLowerCase() === id)
}

/** The hook comes from the recorded holder: its pane, its launch and (when known) its agent pid. */
export function holderMatches(holder: HolderIdentity | null, hook: HookConversation): boolean {
  return (
    holder !== null &&
    holder.paneKey === hook.paneKey &&
    hook.launchHash !== null &&
    holder.launchHash === hook.launchHash &&
    (holder.agentPid === null || holder.agentPid === hook.agentPid)
  )
}

export function eligibleFor(item: AnswerItem, event: AnswerTakeEvent): boolean {
  if (item.state !== 'offered' || item.sends.length >= ANSWER_MAX_HOOK_COPIES) {
    return false
  }
  if (event.name === 'Stop') {
    // Why: one Stop block per item (spent when handed out), and none on a turn a Stop hook already
    // continued once the item was handed out at all.
    return !item.stopOffered && !(event.stopHookActive && item.sends.length > 0)
  }
  return true
}

export function sameHolder(a: HolderIdentity | null, b: HolderIdentity): boolean {
  return a !== null && a.paneKey === b.paneKey && a.launchHash === b.launchHash
}
