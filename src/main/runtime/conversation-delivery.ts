/**
 * Put ONE message into a conversation, exactly as the person would have.
 *
 * There is no third door. A terminal conversation gets the same host prompt
 * submission a worker or a chain step gets — the same per-PTY session input queue,
 * the same bracketed paste, the same measured Enter delay — and a chat conversation
 * gets the same `agentSession.send` mutation the composer sends, under the person's
 * own source authority. Nothing here composes, prefixes or explains the text: the
 * agent sees what it would have seen if the person had typed it.
 *
 * `operationId` is the idempotency key BOTH doors already have: the PTY queue
 * replays a repeated `clientMessageId` inside its TTL instead of writing twice, and
 * a structured send with the same `clientOperationId` is answered from the ledger.
 * A caller that persists the id before calling can therefore retry safely.
 *
 * A refusal before any byte moved is a `ConversationNotSentError` with the same words; every
 * other failure may have reached the agent.
 */

import { hostname } from 'node:os'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { ConversationSource } from '../../shared/conversation-source'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { GuardedWriteReceiver } from '../pty/guarded-pty-write'
import { writeRefusedWholly } from './agent-question-answer-guards'
import { ConversationNotSentError } from './conversation-delivery-not-sent'
import {
  deliverUnderSessionHostAdmission,
  type SessionHostDeliveryAdmission
} from '../session-host/session-host-delivery-admission'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { deliverThroughSshSessionHost } from '../session-host-owner/ssh-session-host-delivery'
import { sshSessionHostClientFor } from '../session-host-owner/ssh-session-host-clients'
import { isWriteFenceOpen } from './conversation-write-fence'
import { hasUnresolvedDraft, withUnresolvedDraftNote } from './terminal-unresolved-draft'
import type { OrcaRuntimeService } from './omni-runtime'

export type ConversationDelivery = {
  door: 'pty' | 'structured'
  deliveredAt: number
}

export const CONVERSATION_DELIVERY_CALLER_KEY = 'trusted-local:conversation-delivery'

type DeliveryOptions = {
  operationId: string
  beforeWrite?: () => void
  /**
   * The agent process a terminal prompt is bound to (`session-prompt-binding`): re-proven before
   * every write, and every write, Enter included, guarded at the PTY (`guarded-pty-write.ts`).
   */
  receiver?: { verify: (ptyId: string) => Promise<void>; process: GuardedWriteReceiver }
  /**
   * Why the conversation is no longer what the prompt was checked against, or null: run last
   * before every terminal write (the text and Enter) and before a chat send.
   */
  conversationGuard?: () => Promise<string | null>
  /** The revocable fence every write is under (`conversation-write-fence.ts`). */
  writeFence?: string
  /** For a conversation the session host registry adopted: who writes, or the admitted operation. */
  hostAdmission?: SessionHostDeliveryAdmission
  /** No person is behind this write (Keep going, the steward): an SSH host checks its hard stops. */
  unattended?: boolean
}

const FENCE_REVOKED = 'Its conversation changed before the prompt went out, so it was not sent.'

export async function deliverToConversation(
  runtime: OrcaRuntimeService,
  source: ConversationSource,
  text: string,
  options: DeliveryOptions
): Promise<ConversationDelivery> {
  if (!text.trim()) {
    throw new Error('There is nothing to send.')
  }
  // Why first: a conversation an SSH relay adopted is admitted there, never written to raw.
  const relayed = options.hostAdmission?.hostOperation
    ? null
    : await deliverThroughSshSessionHost({
        runtime,
        source,
        text,
        operationId: options.operationId,
        writer: options.hostAdmission?.writer ?? 'conversation-delivery',
        unattended: options.unattended === true,
        computer: hostname(),
        clientFor: sshSessionHostClientFor
      })
  if (relayed) {
    return relayed
  }
  // Why here: every automatic writer passes this door, so an adopted conversation admits each one.
  return await deliverUnderSessionHostAdmission({
    host: activeRuntimeSessionHost(),
    source,
    text,
    operationId: options.operationId,
    ...(options.hostAdmission ? { admission: options.hostAdmission } : {}),
    deliver: async () =>
      source.kind === 'structured'
        ? await deliverToStructuredConversation(source, text, options)
        : await deliverToTerminalConversation(runtime, source, text, options)
  })
}

async function deliverToTerminalConversation(
  runtime: OrcaRuntimeService,
  source: ConversationSource,
  text: string,
  options: DeliveryOptions
): Promise<ConversationDelivery> {
  const pane = resolveTerminalConversation(runtime, source)
  let writing = false
  let landed = false
  let writtenTo: string | null = null
  try {
    await runtime.sendTerminalAgentPrompt(pane.handle, text, {
      clientMessageId: options.operationId,
      // Why: the submission calls this before each write, so a failure before it moved nothing.
      // Why sync without a binding: the guard must throw in the same tick it is asked.
      beforeWrite:
        options.receiver || options.conversationGuard
          ? async (ptyId: string) => {
              options.beforeWrite?.()
              await options.receiver?.verify(ptyId)
              const moved = await options.conversationGuard?.()
              if (moved) {
                throw new Error(moved)
              }
              writing = true
              writtenTo = ptyId
            }
          : (ptyId: string) => {
              options.beforeWrite?.()
              writing = true
              writtenTo = ptyId
            },
      reserveWrite: options.beforeWrite,
      afterWrite: () => {
        landed = true
      },
      ...(options.receiver ? { receiver: options.receiver.process } : {}),
      ...(options.writeFence ? { writeFence: options.writeFence } : {})
    })
  } catch (error) {
    // Why the guard refusals too: a write its guard refused before any byte landed sent nothing.
    if (!writing || (!landed && writeRefusedWholly(error))) {
      throw new ConversationNotSentError(error)
    }
    // Text it left in the input box is named, so the person sees why nothing more is sent there.
    throw writtenTo && hasUnresolvedDraft(writtenTo) ? withUnresolvedDraftNote(error) : error
  }
  return { door: 'pty', deliveredAt: Date.now() }
}

function resolveTerminalConversation(
  runtime: OrcaRuntimeService,
  source: ConversationSource
): { handle: string } {
  try {
    return runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
  } catch {
    // Why re-worded: `terminal_not_found` is a wire code, and this message is read
    // by the person whose prompt is still waiting.
    throw new ConversationNotSentError('This terminal conversation is no longer open.')
  }
}

const STRUCTURED_CLOSED = 'This chat conversation is no longer open.'

async function deliverToStructuredConversation(
  source: ConversationSource,
  text: string,
  options: Pick<DeliveryOptions, 'operationId' | 'conversationGuard' | 'beforeWrite' | 'writeFence'>
): Promise<ConversationDelivery> {
  const host = getStructuredAgentSessionHost()
  const sessionId = source.sessionId ?? null
  // Nothing has been asked of the session host yet: each refusal before `send` moved nothing.
  if (!host || !sessionId) {
    throw new ConversationNotSentError(STRUCTURED_CLOSED)
  }
  // Why re-derived rather than trusted: the pane key is minted from the session id,
  // so a record whose two halves disagree is addressing a different conversation.
  if (
    structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId) !==
    source.paneKey
  ) {
    throw new ConversationNotSentError(STRUCTURED_CLOSED)
  }
  // Last before the send, with nothing awaited between: the conversation is still what was checked.
  const moved = await options.conversationGuard?.()
  if (moved) {
    throw new ConversationNotSentError(moved)
  }
  if (options.writeFence && !isWriteFenceOpen(options.writeFence)) {
    throw new ConversationNotSentError(FENCE_REVOKED)
  }
  const fence = host.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? null
  if (fence === null) {
    throw new ConversationNotSentError(STRUCTURED_CLOSED)
  }
  // The caller's own final check (Keep going still wants this round), after the last await.
  try {
    options.beforeWrite?.()
  } catch (error) {
    throw new ConversationNotSentError(error)
  }
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  }
  const result = await host.send(
    // The person queued this text through the authenticated interface; it carries
    // their authority, which is what makes it identical to typing it.
    { callerKey: CONVERSATION_DELIVERY_CALLER_KEY, userSourceAuthority: true },
    {
      envelope: {
        sessionId,
        clientOperationId: options.operationId,
        expectedRuntimeFence: fence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId,
          fields: { body }
        })
      },
      body,
      beforeRun: () => {
        if (options.writeFence && !isWriteFenceOpen(options.writeFence)) {
          throw new ConversationNotSentError(FENCE_REVOKED)
        }
        try {
          options.beforeWrite?.()
        } catch (error) {
          throw new ConversationNotSentError(error)
        }
      }
    }
  )
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  if (result.value.submission.dispatchState === 'rejected') {
    throw new ConversationNotSentError(
      result.value.submission.reason ?? 'The chat send was refused.'
    )
  }
  if (result.value.submission.dispatchState !== 'accepted') {
    throw new Error(
      'The chat send could not be confirmed. Inspect the conversation before retrying.'
    )
  }
  return { door: 'structured', deliveredAt: Date.now() }
}
