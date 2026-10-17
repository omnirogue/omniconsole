/**
 * Which conversation a message is about — the pane a person is looking at, named
 * without a chain, an outcome or a plan.
 *
 * A Conversation is Message → Response. Everything that needs to say "this pane,
 * on this workspace, reached through this door" says it with this record: the
 * prompt queue today, the WorkPlan "same conversation" route later. It carries no
 * intent and no work; it is an address.
 *
 * `paneKey` is the same identity the session-chain source authority uses, so
 * `conversationSourceRowKey` and `SessionChain.sourceRowKey` are the same string
 * for the same pane (`session-outcome-source-authority.ts`).
 */

import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from './structured-agent-session-projection'

/**
 * Who asked for a message to be delivered. ONE namespace for the idempotency key every sender
 * mints, because all of them reach the same per-PTY queue and the same structured ledger: a key is
 * unique across the doors, so a restart can tell a replayed prompt-queue send from a replayed
 * same-conversation step and never double-delivers either.
 */
export const CONVERSATION_DELIVERY_SENDERS = [
  'prompt-queue',
  'same-session',
  'up-next',
  'up-next-stage'
] as const
export type ConversationDeliverySender = (typeof CONVERSATION_DELIVERY_SENDERS)[number]

/**
 * The idempotency key for one delivery. It is shaped for the structured door's ledger
 * (`<13-digit ms>-<32 hex>`, see `parseAgentSessionOperationTimestamp`): the PTY door accepts any
 * string, but the structured door refuses every other shape with `agent_session_operation_invalid`
 * before a byte moves. Measured 2026-09-20: `prompt-queue:<uuid>` ids made every Up-next prompt to a
 * native chat conversation fail. The sender is recorded by the caller's own receipt (queue entry,
 * chain step), not inside the id.
 */
export function conversationDeliveryOperationId(
  _sender: ConversationDeliverySender,
  unique: string,
  now: number = Date.now()
): string {
  const timestamp = Math.trunc(now).toString()
  const entropy = unique.replaceAll('-', '').toLowerCase()
  if (!/^\d{13}$/.test(timestamp) || !/^[0-9a-f]{32}$/.test(entropy)) {
    throw new Error('Unable to create a durable delivery operation id')
  }
  return `${timestamp}-${entropy}`
}

/** Which door the person's own message goes through on this conversation. */
export type ConversationSourceKind = 'pty' | 'structured'

export type ConversationSource = {
  worktreeId: string
  paneKey: string
  kind: ConversationSourceKind
  /** Present on `structured`: the chat session the pane key was minted from. */
  sessionId?: string
}

const KINDS: readonly ConversationSourceKind[] = ['pty', 'structured']

/** The same conversation: its workspace, pane and kind (and chat session) all match. */
export function sameConversationSource(a: ConversationSource, b: ConversationSource): boolean {
  return (
    a.worktreeId === b.worktreeId &&
    a.paneKey === b.paneKey &&
    a.kind === b.kind &&
    (a.kind !== 'structured' || a.sessionId === b.sessionId)
  )
}

/** The sidebar row identity for this conversation; local conversations only. */
export function conversationSourceRowKey(
  source: Pick<ConversationSource, 'worktreeId' | 'paneKey'>
): string {
  return JSON.stringify(['local', source.worktreeId, source.paneKey])
}

/** The pane key a structured chat's session is addressed by. */
export function structuredConversationSource(
  worktreeId: string,
  sessionId: string
): ConversationSource {
  return {
    worktreeId,
    paneKey: structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId),
    kind: 'structured',
    sessionId
  }
}

/** Untrusted input (persisted JSON, RPC params); null when it addresses nothing. */
export function normalizeConversationSource(raw: unknown): ConversationSource | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const worktreeId = typeof value.worktreeId === 'string' ? value.worktreeId.trim() : ''
  const paneKey = typeof value.paneKey === 'string' ? value.paneKey.trim() : ''
  const kind = KINDS.find((candidate) => candidate === value.kind)
  if (!worktreeId || !paneKey || !kind) {
    return null
  }
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
  // A structured conversation with no session cannot be written to; refuse it here
  // rather than let the delivery door discover it with a message in hand.
  if (kind === 'structured' && !sessionId) {
    return null
  }
  return { worktreeId, paneKey, kind, ...(sessionId ? { sessionId } : {}) }
}

export function conversationSourcesEqual(
  left: ConversationSource,
  right: ConversationSource
): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.paneKey === right.paneKey &&
    left.kind === right.kind &&
    (left.sessionId ?? null) === (right.sessionId ?? null)
  )
}
