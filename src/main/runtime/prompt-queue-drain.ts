/**
 * Drain one queued prompt only while its conversation is free (an answer to working Claude:
 * mid-turn, `prompt-queue-mid-turn.ts`) and no live plan owns it.
 * Persist sending before bytes; never replay an uncertain send, even in the same epoch.
 */

import { randomUUID } from 'node:crypto'
import {
  conversationDeliveryOperationId,
  conversationSourceRowKey,
  type ConversationSource
} from '../../shared/conversation-source'
import {
  nextPromptQueueEntry,
  PROMPT_QUEUE_MAX_REASON_LENGTH,
  type PromptQueue,
  type PromptQueueEntry
} from '../../shared/prompt-queue-types'
import { observeConversationReadiness, type ConversationReadiness } from './conversation-readiness'
import { deliverToConversation } from './conversation-delivery'
import { ConversationNotSentError } from './conversation-delivery-not-sent'
import type { OrcaRuntimeService } from './omni-runtime'
import { CAPACITY_RECOVERY_ENTRY_PREFIX } from '../../shared/conversation-capacity-recovery'
import { LOGIN_RESUME_ENTRY_PREFIX } from '../answer-delivery/login-killed-turns'
import { isChainBoundToConversation } from './conversation-chain-ownership'
import { getNextStepKeepGoingController } from '../next-steps/next-step-suggestion-slot'
import { releaseSessionPrompt, sessionPromptBinding } from './session-prompt-binding'
import { closeWriteFence, openWriteFence } from './conversation-write-fence'
import { paneAgentRefusal, readPaneAgentPresence } from './prompt-queue-agent-presence'
import { sessionContextQueueRefusal } from './prompt-queue-context-identity'
import { assertPromptQueueEntryDelivery } from './prompt-queue-entry-guard'
import {
  PROMPT_QUEUE_CONVERSATION_NOT_FREE,
  promptQueueAnswerRetry
} from './prompt-queue-answer-retry'
import { heldByPreviousDelivery, holdPromptQueueAfterDelivery } from './prompt-queue-delivery-hold'
import { settleAnswerPastRetryDay, settleAnswersForClosedPane } from './prompt-queue-closed-pane'
import {
  CLAUDE_ANSWER_FENCE,
  claudeWorkingWithNothingOpen,
  isClaudeTerminalAnswer,
  mayAnswerMidTurn
} from './prompt-queue-mid-turn'
export { isChainBoundToConversation } from './conversation-chain-ownership'
export {
  holdPromptQueueAfterDelivery,
  isPromptQueueDeliveryHeld,
  PROMPT_QUEUE_DELIVERY_SETTLE_MS
} from './prompt-queue-delivery-hold'

/** Shown on another session's prompt whose agent binding this process never held. */
export const PROMPT_QUEUE_UNBOUND_RELAY =
  'OmniConsole restarted after another session queued this, so the agent it was meant for can no longer be confirmed. It was not sent; ask again.'

/** Shown on an entry whose delivery this process cannot account for. */
export const PROMPT_QUEUE_UNCONFIRMED_DELIVERY =
  'OmniConsole restarted while this prompt was being sent, so it cannot confirm the agent received it. Queue it again if the agent did not answer it.'

const draining = new Set<string>()

export async function drainPromptQueues(
  runtime: OrcaRuntimeService,
  options: { epoch: string }
): Promise<void> {
  const queues = runtime.listPromptQueues()
  for (const [rowKey, queue] of Object.entries(queues)) {
    if (draining.has(rowKey)) {
      continue
    }
    draining.add(rowKey)
    try {
      await drainOnePromptQueue(runtime, rowKey, queue, options.epoch)
    } catch (error) {
      // A queue that cannot be read or written is not a reason to stop the others.
      console.warn('[prompt-queue] drain failed', rowKey, error)
    } finally {
      draining.delete(rowKey)
    }
  }
}

async function drainOnePromptQueue(
  runtime: OrcaRuntimeService,
  rowKey: string,
  queue: PromptQueue,
  epoch: string
): Promise<void> {
  const stranded = strandedDelivery(queue, epoch)
  if (stranded) {
    runtime.settlePromptQueueEntry(rowKey, stranded.id, {
      state: 'failed',
      reason: PROMPT_QUEUE_UNCONFIRMED_DELIVERY
    })
    return
  }
  if (queue.entries.some((candidate) => candidate.state === 'sending')) {
    return
  }
  if (settleAnswersForClosedPane(runtime, rowKey, queue, Date.now())) {
    return
  }
  const entry = nextPromptQueueEntry(queue, Date.now())
  if (!entry || isChainBoundToConversation(runtime, queue.source)) {
    return
  }
  // Why now, not once the agent stops: a restart forgot where another session's prompt may go, so
  // it can never be sent as queued. Failing it at once lets an answer's sender queue it again,
  // bound, and so reach an agent that keeps working.
  if (entry.requestedBy && !sessionPromptBinding(rowKey, entry.id)) {
    runtime.settlePromptQueueEntry(rowKey, entry.id, {
      state: 'failed',
      reason: PROMPT_QUEUE_UNBOUND_RELAY,
      unsent: true
    })
    return
  }
  // Why: a login failure leaves the pane at a failed turn (never free); only the one continue prompt
  // queued for that failure, once the login works again, may go to it.
  const loginResume = entry.id.startsWith(LOGIN_RESUME_ENTRY_PREFIX)
  const freeFor = (reading: ConversationReadiness): ConversationReadiness =>
    loginResume && reading.failureKind === 'authentication' ? { ...reading, free: true } : reading
  const readiness = freeFor(await observeConversationReadiness(runtime, queue.source))
  // Why past the hold too: Claude queues each answer typed mid-turn; none waits on another.
  const midTurn = await mayAnswerMidTurn(runtime, rowKey, queue.source, entry, readiness)
  if (!midTurn && heldByPreviousDelivery(runtime, rowKey, readiness, Date.now())) {
    return
  }
  // FREE, not "finished a turn": the person's message waits for the agent to stop working, and a
  // pane that never ran a turn has nothing to wait for. Reading the chain's question here held a
  // typed `/next` on a brand-new pane until some other turn happened to run.
  if (!readiness.free && !midTurn) {
    settleAnswerPastRetryDay(runtime, rowKey, entry, Date.now())
    return
  }
  const automaticRecovery = entry.id.startsWith(CAPACITY_RECOVERY_ENTRY_PREFIX)
  const keepGoing = entry.origin?.kind === 'keep-going'
  const contextOrigin = entry.origin?.kind === 'session-context' ? entry.origin : null
  const contextRefusal = (): string | null =>
    contextOrigin ? sessionContextQueueRefusal(runtime, queue.source, contextOrigin.identity) : null
  const guard = (): void => assertPromptQueueEntryDelivery(runtime, rowKey, queue.source, entry)
  try {
    guard()
  } catch (error) {
    runtime.settlePromptQueueEntry(rowKey, entry.id, {
      state: 'failed',
      reason: describeDeliveryFailure(error),
      unsent: true
    })
    return
  }
  // Another session's prompt goes only where it was bound at queueing (`session-prompt-binding`).
  const binding = entry.requestedBy ? sessionPromptBinding(rowKey, entry.id) : null
  const receiver = contextOrigin?.process ?? binding?.receiver ?? null
  // The person's own prompt has no receiver bound at queueing: prove its agent here, at every write.
  const presence =
    receiver || entry.requestedBy ? null : await readPaneAgentPresence(runtime, queue.source)
  const claudeAnswer = isClaudeTerminalAnswer(rowKey, queue.source, entry)
  const conversationGuard = async (): Promise<string | null> => {
    const fresh = freeFor(await observeConversationReadiness(runtime, queue.source))
    // Why any Claude answer: refusing Enter to a turn that began mid-paste stranded the text.
    const open = fresh.free || (claudeAnswer && claudeWorkingWithNothingOpen(runtime, queue.source))
    if (!open || fresh.unverifiable) {
      return PROMPT_QUEUE_CONVERSATION_NOT_FREE
    }
    return (
      (await paneAgentRefusal(runtime, presence)) ??
      (await binding?.conversationGuard?.()) ??
      contextRefusal()
    )
  }
  // Revoked by any change main hears of for the conversation, and checked at the writer itself.
  const writeFence =
    entry.requestedBy || contextOrigin
      ? openWriteFence(
          queue.source,
          () => (binding?.conversationStill?.() ?? true) && contextRefusal() === null,
          claudeAnswer ? CLAUDE_ANSWER_FENCE : {}
        )
      : null
  try {
    if (entry.requestedBy && (!binding || (queue.source.kind === 'pty' && !receiver))) {
      throw new Error(PROMPT_QUEUE_UNBOUND_RELAY)
    }
    // An early refusal only; the guarded write runs the same guard again before the text and Enter.
    const moved = await conversationGuard?.()
    if (moved) {
      throw new Error(moved)
    }
    if (receiver) {
      await runtime.assertTerminalAgentProcess(receiver, receiver.ptyId)
    }
  } catch (error) {
    if (writeFence) {
      closeWriteFence(writeFence)
    }
    if (!retryLater(runtime, rowKey, entry, error)) {
      releaseSessionPrompt(rowKey, entry.id)
      runtime.settlePromptQueueEntry(rowKey, entry.id, {
        state: 'failed',
        reason: describeDeliveryFailure(error),
        unsent: true
      })
    }
    return
  }
  const operationId = automaticRecovery
    ? entry.id
    : conversationDeliveryOperationId('prompt-queue', randomUUID())
  let admitted = false
  // Why re-read: the awaits above can outlive a reorder, a removal or a "send now" here.
  const current = runtime.readPromptQueue(rowKey)
  try {
    if (current && nextPromptQueueEntry(current, Date.now())?.id === entry.id) {
      // The receipt lands on disk BEFORE a byte moves. Everything after this point is
      // either a delivery or a recorded failure — never a silent retry.
      runtime.markPromptQueueEntrySendingAndFlush(rowKey, entry.id, {
        operationId,
        deliveryEpoch: epoch
      })
      admitted = true
    }
  } finally {
    // Nothing moved: the next tick takes whatever is first then. A still-waiting relay keeps its binding.
    if (!admitted) {
      if (!current?.entries.some((row) => row.id === entry.id && row.state === 'queued')) {
        releaseSessionPrompt(rowKey, entry.id)
      }
      if (writeFence) {
        closeWriteFence(writeFence)
      }
    }
  }
  if (!admitted) {
    return
  }
  // A retried answer keeps its receiver binding; every other ending releases it.
  let waitsToRetry = false
  try {
    const hostOperation = entry.requestedBy?.hostOperation
    const delivery = await deliverToConversation(runtime, queue.source, entry.text, {
      operationId,
      // Why: a prompt the session host admitted is its dispatch, checked rather than re-admitted.
      hostAdmission: hostOperation
        ? { hostOperation }
        : { writer: keepGoing ? 'keep-going' : 'prompt-queue' },
      unattended:
        keepGoing || entry.requestedBy?.actor === 'steward' || entry.automation !== undefined,
      beforeWrite: guard,
      ...(receiver
        ? {
            receiver: {
              verify: (ptyId: string) => runtime.assertTerminalAgentProcess(receiver, ptyId),
              process: receiver
            }
          }
        : {}),
      conversationGuard,
      ...(writeFence ? { writeFence } : {})
    })
    runtime.settlePromptQueueEntry(rowKey, entry.id, {
      state: 'delivered',
      deliveredAt: delivery.deliveredAt,
      door: delivery.door
    })
    if (keepGoing) {
      // Counts the round at delivery, so a slow decision log can never let it run past the cap.
      getNextStepKeepGoingController()?.onDelivered(queue.source, entry.id)
    }
    holdPromptQueueAfterDelivery(runtime, rowKey, readiness.version)
  } catch (error) {
    const notSent = error instanceof ConversationNotSentError
    waitsToRetry = notSent && retryLater(runtime, rowKey, entry, error)
    if (!waitsToRetry) {
      runtime.settlePromptQueueEntry(rowKey, entry.id, {
        state: 'failed',
        reason: describeDeliveryFailure(error),
        ...(notSent ? { unsent: true as const } : {})
      })
    }
  } finally {
    if (!waitsToRetry) {
      releaseSessionPrompt(rowKey, entry.id)
    }
    if (writeFence) {
      closeWriteFence(writeFence)
    }
  }
}

/** True when the answer went back to `queued` to try again later; nothing of it was written. */
function retryLater(
  runtime: OrcaRuntimeService,
  rowKey: string,
  entry: PromptQueueEntry,
  error: unknown
): boolean {
  const retry = promptQueueAnswerRetry(entry, error, Date.now())
  return Boolean(retry && runtime.retryPromptQueueEntryLater(rowKey, entry.id, retry))
}

/** An in-flight entry left by a process that is gone; its result is unknowable. */
function strandedDelivery(queue: PromptQueue, epoch: string): PromptQueueEntry | null {
  return (
    queue.entries.find((entry) => entry.state === 'sending' && entry.deliveryEpoch !== epoch) ??
    null
  )
}

/**
 * A queued prompt is going out RIGHT NOW on this conversation. The reverse of the rule above, for
 * the other sender: a WorkPlan step routed `same-session` asks this before it delivers, so the
 * person's own queued text and a plan's continued turn can never interleave on one conversation.
 */
export function isPromptQueueSendingOnConversation(
  runtime: Pick<OrcaRuntimeService, 'readPromptQueue'>,
  source: ConversationSource
): boolean {
  return (
    draining.has(conversationSourceRowKey(source)) ||
    Boolean(
      runtime
        .readPromptQueue(conversationSourceRowKey(source))
        ?.entries.some((entry) => entry.state === 'sending')
    )
  )
}

function describeDeliveryFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.trim() || 'The prompt could not be delivered.').slice(
    0,
    PROMPT_QUEUE_MAX_REASON_LENGTH
  )
}
