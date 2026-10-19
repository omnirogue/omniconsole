/**
 * The listener side of hook-first answers. Only a hook the listener accepted takes part, and only
 * from the holder's pane, launch and (when known) agent process. It first confirms answers its
 * conversation was given earlier, then may carry the next waiting one. The answer counts as
 * injected only when the hook script acknowledges it printed the reply (`ack`); no ack, and it is
 * offered again at the next step. Off, nothing new is carried; earlier injections still confirm.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { transcriptSessionIdOf } from '../../shared/session-reference'
import type { AnswerInbox, AnswerTakeEvent, HookConversation } from './answer-inbox'
import { fitHookAnswerReply } from './answer-inbox-render'

export type AgentHookAnswerReplyInput = {
  source: AgentHookSource
  body: unknown
  /** The event the listener accepted for this request. */
  event: AgentHookEventPayload
  /** The reply the listener would send without answers (the next-step pointer), or null. */
  pointer: string | null
  /** False once the hook can no longer read a reply in time (an extra guard; the ack decides). */
  deliverable(): boolean
}

export type AgentHookAnswerReply = {
  /** The provider JSON the hook prints. */
  body: string
  /** `<item id> <nonce>`, echoed by the hook script's acknowledgement. */
  ack: string
  /** A Stop the reply blocks: the turn goes on, so it is not recorded as ended unless never acked. */
  continuesTurn: boolean
}

export type AgentHookAnswerProof = {
  source: AgentHookSource
  body: unknown
  event: AgentHookEventPayload
  /** When the hook ran (a replayed spool record's own time). */
  at: number
}

export type AgentHookAnswerReplies = {
  reply(input: AgentHookAnswerReplyInput): AgentHookAnswerReply | null
  /** The hook printed the reply carrying this ack token. */
  ack(token: string): boolean
  /** No ack came for this token: the answer is offered again. */
  expire(token: string): void
  /** A replayed spool record: it may confirm, never carry. */
  confirm(proof: AgentHookAnswerProof): void
}

// Why: each is a new step taken after earlier context was read; a sibling PostToolUse of the same tool batch is not.
const PROOF_EVENTS = new Set(['UserPromptSubmit', 'PreToolUse', 'Stop'])
const CARRYING_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'Stop'])
const SESSION_START_SOURCES = new Set(['resume', 'compact'])

function hookPayload(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  let raw = (body as Record<string, unknown>).payload
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

type AcceptedHook = { conversation: HookConversation; payload: Record<string, unknown> }

function takeEvent(payload: Record<string, unknown>): AnswerTakeEvent | null {
  const name = payload.hook_event_name
  if (name === 'SessionStart') {
    return SESSION_START_SOURCES.has(String(payload.source)) ? { name } : null
  }
  if (typeof name === 'string' && CARRYING_EVENTS.has(name)) {
    return {
      name: name as AnswerTakeEvent['name'],
      stopHookActive: payload.stop_hook_active === true
    }
  }
  return null
}

function pointerContext(pointer: string): string | undefined {
  try {
    const parsed = JSON.parse(pointer) as { hookSpecificOutput?: { additionalContext?: unknown } }
    const context = parsed.hookSpecificOutput?.additionalContext
    return typeof context === 'string' ? context : undefined
  } catch {
    return undefined
  }
}

const parseToken = (token: string) => {
  const [id = '', nonce = '', extra] = token.trim().split(/\s+/)
  return id && nonce && extra === undefined ? { id, nonce } : null
}

export function createHookAnswerReplies(
  inbox: AnswerInbox,
  options: { enabled(): boolean }
): AgentHookAnswerReplies {
  /** An accepted lead event of a launch-claimed pane, with the conversation ids its payload carries. */
  const acceptedHook = (
    source: AgentHookSource,
    body: unknown,
    event: AgentHookEventPayload
  ): AcceptedHook | null => {
    const payload = inbox.isEmpty() ? null : hookPayload(body)
    const token = event.launchToken?.trim()
    if (
      (source !== 'claude' && source !== 'codex') ||
      !payload ||
      !token ||
      text(payload.agent_id) ||
      event.toolAgentId
    ) {
      return null
    }
    const ids = [
      text(payload.session_id),
      text(event.providerSession?.id),
      ...[text(payload.transcript_path), text(event.providerSession?.transcriptPath)].map((path) =>
        path ? transcriptSessionIdOf(path) : null
      )
    ].filter((id): id is string => id !== null)
    const conversation: HookConversation = {
      provider: source,
      ids,
      paneKey: event.paneKey,
      launchHash: sha256(token),
      agentPid: typeof event.agentPid === 'number' ? event.agentPid : null
    }
    return ids.length > 0 ? { conversation, payload } : null
  }
  const confirm = (hook: AcceptedHook, at?: number) => {
    if (PROOF_EVENTS.has(String(hook.payload.hook_event_name))) {
      inbox.confirm(hook.conversation, at)
    }
  }
  return {
    confirm: ({ source, body, event, at }) => {
      const hook = acceptedHook(source, body, event)
      if (hook) {
        confirm(hook, at)
      }
    },
    reply: ({ source, body, event, pointer, deliverable }) => {
      const hook = acceptedHook(source, body, event)
      if (!hook) {
        return null
      }
      confirm(hook)
      const take = options.enabled() ? takeEvent(hook.payload) : null
      // Why deliverable: a reply the hook already gave up on is never handed out.
      const item = take && deliverable() ? inbox.take(hook.conversation, take) : null
      if (!take || !item) {
        return null
      }
      const extra =
        take.name === 'UserPromptSubmit' && pointer ? pointerContext(pointer) : undefined
      const reply = fitHookAnswerReply(take.name, item.text, item.compact, extra)
      if (!reply) {
        // Too long beside the pointer: the pointer goes now, the answer at the next step.
        return null
      }
      const nonce = randomUUID()
      if (!inbox.reserve(item.id, nonce, take.name, hook.conversation)) {
        return null
      }
      return { body: reply, ack: `${item.id} ${nonce}`, continuesTurn: take.name === 'Stop' }
    },
    ack: (token) => {
      const parsed = parseToken(token)
      return parsed ? inbox.ack(parsed.id, parsed.nonce) : false
    },
    expire: (token) => {
      const parsed = parseToken(token)
      if (parsed) {
        inbox.release(parsed.id, parsed.nonce)
      }
    }
  }
}
