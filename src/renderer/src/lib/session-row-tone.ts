import type { ConversationState } from './conversation-state'

/**
 * The one tint a Conversations row carries at rest: green while an agent works, peach while it
 * needs the person, muted blue while it waits, dark grey once stopped. Done carries no tint, so
 * only a question pulls the eye.
 */
export type SessionRowTone = 'active' | 'needs-you' | 'waiting' | 'done' | 'stopped'

export function sessionRowTone(input: {
  visualState: ConversationState
  needsYou: boolean
  /**
   * A put-away row (saved or archived): being done is why it is there, so only a question tints
   * it and a folder color shows instead.
   */
  putAway: boolean
}): SessionRowTone | null {
  if (input.needsYou || input.visualState === 'needs-you') {
    return 'needs-you'
  }
  if (input.putAway) {
    return null
  }
  switch (input.visualState) {
    case 'running':
    case 'working':
    case 'recovering':
      return 'active'
    case 'done':
    case 'inactive':
      return 'done'
    case 'queued':
    case 'awaiting':
    case 'waiting':
      return 'waiting'
    case 'failed':
    case 'interrupted':
      return 'stopped'
    case 'plan-ready':
    case 'active':
    case 'unverifiable':
    case 'none':
      return null
  }
}
