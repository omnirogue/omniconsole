/**
 * The listener's gate for hook-first answers. A reply carrying an answer starts with one line,
 * `omni-answer <item id> <nonce>`, which the managed hook script strips before printing the JSON
 * and then echoes back to HOOK_ANSWER_ACK_PATHNAME. Only that acknowledgement counts the answer as
 * injected; without it the answer is offered again. Replayed spool records may confirm.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  HOOK_ANSWER_ACK_PATHNAME,
  HOOK_ANSWER_REPLY_PREFIX
} from '../../shared/agent-hook-answer-ack'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import type {
  AgentHookAnswerProof,
  AgentHookAnswerReplies,
  AgentHookAnswerReply,
  AgentHookAnswerReplyInput
} from '../answer-inbox/hook-answer-reply'

/** An answer is handed out only while the request has been open at most this long (extra guard). */
export const HOOK_ANSWER_OPEN_WINDOW_MS = 600
/** How long the hook's acknowledgement may take before the answer is offered again. */
export const HOOK_ANSWER_ACK_WAIT_MS = 3_000
/** Header a hook sends on a retry past its own deadline: the reply may not carry an answer. */
export const HOOK_ANSWER_LATE_HEADER = 'x-omni-agent-hook-late'
const EARLY_PROOFS_MAX = 200

export { HOOK_ANSWER_ACK_PATHNAME }

export function hookAnswerReplyOpen(
  req: IncomingMessage,
  openedAt: number,
  now: number = Date.now()
): boolean {
  return (
    now - openedAt <= HOOK_ANSWER_OPEN_WINDOW_MS &&
    req.headers[HOOK_ANSWER_LATE_HEADER] !== '1' &&
    !req.socket.destroyed
  )
}

export function hookAnswerResponseBody(reply: AgentHookAnswerReply): string {
  return `${HOOK_ANSWER_REPLY_PREFIX}${reply.ack}\n${reply.body}`
}

/**
 * A SessionStart from a compaction: providers record no status for it (it fires mid-turn), so it
 * reaches the answer provider as a bare event of its pane and launch, never as an idle boundary.
 */
export function compactAnswerEvent(
  source: AgentHookSource,
  body: unknown
): AgentHookEventPayload | null {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  let payload = record?.payload
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      return null
    }
  }
  const hook = payload as Record<string, unknown> | null
  const paneKey = typeof record?.paneKey === 'string' ? record.paneKey.trim() : ''
  if (
    (source !== 'claude' && source !== 'codex') ||
    hook?.hook_event_name !== 'SessionStart' ||
    hook.source !== 'compact' ||
    !paneKey
  ) {
    return null
  }
  const pid = Number(record?.agentPid)
  return {
    paneKey,
    source,
    connectionId: null,
    hookEventName: 'SessionStart',
    ...(typeof record?.launchToken === 'string' ? { launchToken: record.launchToken } : {}),
    ...(Number.isInteger(pid) && pid > 1 ? { agentPid: pid } : {}),
    payload: {} as AgentHookEventPayload['payload']
  }
}

/**
 * Per-pane count of applied status writes. A Stop whose answer block was never acknowledged is
 * recorded as the end of the turn only if nothing newer was applied to its pane meanwhile.
 */
export class PaneStatusEpochs {
  private readonly epochs = new Map<string, number>()

  bump(paneKey: string): void {
    this.epochs.set(paneKey, (this.epochs.get(paneKey) ?? 0) + 1)
  }

  /** True while nothing newer has been applied to the pane and it was not forgotten since. */
  fence(paneKey: string): () => boolean {
    const at = this.epochs.get(paneKey)
    return () => this.epochs.get(paneKey) === at
  }

  forget(paneKey: string): void {
    this.epochs.delete(paneKey)
  }
}

/** Only what a confirmation reads, so held records never pin large prompts or tool output. */
function slimProof(proof: AgentHookAnswerProof): AgentHookAnswerProof {
  const raw = (proof.body as { payload?: unknown } | null)?.payload
  let payload: Record<string, unknown> = {}
  try {
    payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
  } catch {
    // An unreadable payload confirms nothing.
  }
  const { hook_event_name, session_id, transcript_path, agent_id } = payload ?? {}
  const { paneKey, launchToken, toolAgentId, providerSession, connectionId, agentPid } = proof.event
  return {
    ...proof,
    body: { payload: { hook_event_name, session_id, transcript_path, agent_id } },
    event: {
      paneKey,
      launchToken,
      toolAgentId,
      providerSession,
      connectionId,
      agentPid,
      payload: {} as AgentHookAnswerProof['event']['payload']
    }
  }
}

export class HookAnswerGate {
  private replies: AgentHookAnswerReplies | null = null
  // Why: the startup spool drain runs before the answer inbox is installed.
  private earlyProofs: AgentHookAnswerProof[] = []
  private readonly awaiting = new Map<string, () => void>()

  set(replies: AgentHookAnswerReplies | null): void {
    this.replies = replies
    const early = this.earlyProofs
    this.earlyProofs = []
    for (const proof of replies ? early : []) {
      this.replayed(proof)
    }
  }

  reply(input: AgentHookAnswerReplyInput): AgentHookAnswerReply | null {
    try {
      return this.replies?.reply(input) ?? null
    } catch (error) {
      console.warn('[agent-hooks] answer reply failed; the listener reply goes as before', error)
      return null
    }
  }

  /** After writing `reply`: no ack in time (or the connection closed first) runs `unacked`. */
  track(res: ServerResponse, reply: AgentHookAnswerReply, unacked: () => void): void {
    let settled = false
    const settle = (acked: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      this.awaiting.delete(reply.ack)
      if (!acked) {
        this.replies?.expire(reply.ack)
        unacked()
      }
    }
    const timer = setTimeout(() => settle(false), HOOK_ANSWER_ACK_WAIT_MS)
    timer.unref?.()
    this.awaiting.set(reply.ack, () => settle(true))
    res.once('close', () => {
      if (!res.writableFinished) {
        settle(false)
      }
    })
  }

  /** The hook script's acknowledgement (form field `ack`). */
  ack(body: unknown): boolean {
    const token = (body as { ack?: unknown } | null)?.ack
    if (typeof token !== 'string' || !this.replies) {
      return false
    }
    const acked = this.replies.ack(token)
    if (acked) {
      this.awaiting.get(token.trim())?.()
    }
    return acked
  }

  replayed(proof: AgentHookAnswerProof): void {
    if (!this.replies) {
      if (this.earlyProofs.length < EARLY_PROOFS_MAX) {
        this.earlyProofs.push(slimProof(proof))
      }
      return
    }
    try {
      this.replies.confirm(proof)
    } catch (error) {
      console.warn('[agent-hooks] replayed answer confirmation failed', error)
    }
  }
}
