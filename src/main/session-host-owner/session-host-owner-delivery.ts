/**
 * `continue` and `ask` on the owner service: session-manage's own queueing (marker, hard stops,
 * Keep going off, bound to the agent process and the checked conversation), run first as a dry run
 * so a refusal comes before anything moves, then for real with the host operation stamped on the
 * queued entry. Dispatch waits for the queue to settle the entry, because the send door admits a
 * named host operation only while that operation is still `dispatched`.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { SessionHostPayloads } from '../../shared/session-host-payload-schema'
import { sessionHostRefusal } from '../../shared/session-host-refusal'
import type { SessionHostPrepared } from '../session-host/session-host-executor'
import type { SessionHostSettlement } from '../session-host/session-host-settlement'
import { queueQuestion } from '../session-manage/session-manage-ask'
import { waitForAskReply, type AskWaitDeps } from '../session-manage/session-manage-ask-wait'
import { continueSession } from '../session-manage/session-manage-continue'
import type {
  SessionDeliveryDeps,
  SessionDeliveryTarget
} from '../session-manage/session-manage-deliver'
import {
  SessionManagePartialError,
  SessionManageRefusal
} from '../session-manage/session-manage-refusal'
import { refusalOf, unattendedRefusal, type OwnerTarget } from './session-host-owner-target'

/** How long a prompt admitted for an idle conversation may still wait in its queue. */
export const HOST_DELIVERY_QUEUED_MS = 5 * 60_000
/** How long a send that started is waited on before its fate is called unknowable. */
export const HOST_DELIVERY_SENDING_MS = 2 * 60_000
const POLL_MS = 250
const ASK_DEFAULT_TIMEOUT_MS = 10 * 60_000

export type OwnerDeliveryDeps = {
  delivery: SessionDeliveryDeps
  readEntry(source: ConversationSource, entryId: string): PromptQueueEntry | null
  /** Settles a still-queued entry as failed in the same tick; false once it started sending. */
  withdrawIfQueued(source: ConversationSource, entryId: string, reason: string): boolean
  askWait(source: ConversationSource, entryId: string): AskWaitDeps
  sleep(ms: number): Promise<void>
  now(): number
}

type HostOperation = { operationId: string; conversationId: string }

function deliveryTarget(target: OwnerTarget): SessionDeliveryTarget {
  const { entry, source, agentProcess } = target.session
  return { entry, source, agentProcess }
}

/** The same deps, stamping the host operation on whatever it queues and noting the entry id. */
function stamped(
  deps: SessionDeliveryDeps,
  hostOperation: HostOperation,
  noted: (entryId: string) => void
): SessionDeliveryDeps {
  return {
    ...deps,
    enqueue: (source, input) =>
      deps.enqueue(source, {
        ...input,
        ...(input.requestedBy ? { requestedBy: { ...input.requestedBy, hostOperation } } : {})
      }),
    bind: (source, entryId, binding) => {
      noted(entryId)
      return deps.bind(source, entryId, binding)
    },
    decideRelayed: (setId, suggestionId, relayed) =>
      deps.decideRelayed(setId, suggestionId, {
        ...relayed,
        requestedBy: { ...relayed.requestedBy, hostOperation }
      })
  }
}

const notDelivered = (message: string, code: 'not-eligible' | 'person-input' = 'not-eligible') =>
  ({ kind: 'not-delivered', refusal: sessionHostRefusal(code, message) }) as const

/** What the queue did with the entry, waited on until it settles or its fate is unknowable. */
export async function settleQueuedEntry(
  deps: OwnerDeliveryDeps,
  source: ConversationSource,
  entryId: string
): Promise<SessionHostSettlement> {
  const queuedUntil = deps.now() + HOST_DELIVERY_QUEUED_MS
  let sendingUntil: number | null = null
  for (;;) {
    const entry = deps.readEntry(source, entryId)
    if (!entry) {
      return notDelivered(
        'The person removed it from the queue before it was sent.',
        'person-input'
      )
    }
    if (entry.state === 'delivered') {
      return {
        kind: 'completed',
        result: { entryId, deliveredAt: entry.deliveredAt ?? deps.now(), door: entry.door ?? null }
      }
    }
    if (entry.state === 'failed') {
      // Why both: an entry that never started sending, or one the door proved it never wrote.
      return entry.unsent || !entry.operationId
        ? notDelivered(`${entry.reason ?? 'It was not sent.'} Nothing was delivered.`)
        : { kind: 'unconfirmed', detail: entry.reason ?? 'The send failed part-way.' }
    }
    const now = deps.now()
    if (entry.state === 'queued' && now >= queuedUntil) {
      const reason =
        'The conversation did not become free in time, so the prompt was withdrawn unsent.'
      if (deps.withdrawIfQueued(source, entryId, reason)) {
        return notDelivered(`${reason} Nothing was delivered.`)
      }
      continue
    }
    if (entry.state === 'sending') {
      sendingUntil ??= now + HOST_DELIVERY_SENDING_MS
      if (now >= sendingUntil) {
        return { kind: 'unconfirmed', detail: 'The send started and did not report back in time.' }
      }
    }
    await deps.sleep(POLL_MS)
  }
}

function refusedBeforeQueueing(error: unknown): SessionHostSettlement | null {
  if (error instanceof SessionManageRefusal) {
    return { kind: 'not-delivered', refusal: refusalOf(error) }
  }
  // Why not delivered: its Keep going changed, but nothing reached the conversation.
  if (error instanceof SessionManagePartialError) {
    return notDelivered(error.message)
  }
  return null
}

export async function prepareHostContinue(
  deps: OwnerDeliveryDeps,
  target: OwnerTarget,
  payload: SessionHostPayloads['continue'],
  hostOperation: HostOperation
): Promise<SessionHostPrepared> {
  const { answer } = payload
  const policy = unattendedRefusal(target, answer.kind === 'prompt' ? 'prompt' : 'yes')
  if (policy) {
    return { kind: 'refuse', refusal: policy }
  }
  const input = { actor: target.actor, target: deliveryTarget(target), answer }
  try {
    await continueSession(deps.delivery, { ...input, dryRun: true })
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      return { kind: 'refuse', refusal: refusalOf(error) }
    }
    throw error
  }
  return {
    kind: 'dispatch',
    dispatch: async () => {
      let entryId: string | null = null
      const run = stamped(deps.delivery, hostOperation, (id) => (entryId = id))
      try {
        await continueSession(run, { ...input, dryRun: false })
      } catch (error) {
        const refused = entryId === null ? refusedBeforeQueueing(error) : null
        if (refused) {
          return refused
        }
        if (entryId === null) {
          throw error
        }
      }
      const { source } = target.session
      return entryId === null || !source
        ? notDelivered('Nothing was queued.')
        : await settleQueuedEntry(deps, source, entryId)
    }
  }
}

export async function prepareHostAsk(
  deps: OwnerDeliveryDeps,
  target: OwnerTarget,
  payload: SessionHostPayloads['ask'],
  hostOperation: HostOperation,
  /** A transfer's brief: only the whole finished reply counts as an answer. */
  options: { requireCompleteReply?: boolean } = {}
): Promise<SessionHostPrepared> {
  const policy = unattendedRefusal(target, 'ask')
  if (policy) {
    return { kind: 'refuse', refusal: policy }
  }
  const input = { actor: target.actor, target: deliveryTarget(target), question: payload.question }
  try {
    await queueQuestion(deps.delivery, { ...input, dryRun: true })
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      return { kind: 'refuse', refusal: refusalOf(error) }
    }
    throw error
  }
  return {
    kind: 'dispatch',
    dispatch: async () => {
      let queued: Awaited<ReturnType<typeof queueQuestion>>
      try {
        queued = await queueQuestion(
          stamped(deps.delivery, hostOperation, () => {}),
          {
            ...input,
            dryRun: false
          }
        )
      } catch (error) {
        const refused = refusedBeforeQueueing(error)
        if (refused) {
          return refused
        }
        throw error
      }
      const { entryId, source, marker } = queued
      if (!entryId) {
        return notDelivered('Nothing was queued.')
      }
      const outcome = await waitForAskReply(deps.askWait(source, entryId), {
        rowKey: conversationSourceRowKey(source),
        marker,
        sentText: queued.result.sent!,
        timeoutMs: payload.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS,
        ...(options.requireCompleteReply ? { requireCompleteReply: true } : {})
      })
      const entry = deps.readEntry(source, entryId)
      if (outcome.outcome === 'answered') {
        return { kind: 'completed', result: { entryId, outcome: 'answered', reply: outcome.reply } }
      }
      if (outcome.outcome === 'timeout' && outcome.question === 'withdrawn') {
        return notDelivered(
          'No answer in time and the question was still waiting, so it was withdrawn unsent.'
        )
      }
      if (entry?.state === 'failed' && (entry.unsent || !entry.operationId)) {
        return notDelivered(`${entry.reason ?? 'It was not sent.'} Nothing was delivered.`)
      }
      if (entry?.state !== 'delivered') {
        return {
          kind: 'unconfirmed',
          detail: 'Whether the question reached the conversation is unknown.'
        }
      }
      return {
        kind: 'completed',
        result:
          outcome.outcome === 'timeout'
            ? { entryId, outcome: 'timeout' }
            : { entryId, outcome: 'failed', failure: outcome.reason }
      }
    }
  }
}
