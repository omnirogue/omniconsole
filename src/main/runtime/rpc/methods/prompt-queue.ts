// `promptQueue.*` — the person's own next prompt for one conversation.
//
// Ordinary conversation only: no method here creates an outcome, a chain, a plan or
// a card. Queuing the next message is a DECISION the person makes at their own
// interface, so every mutation goes through the same `assertSessionOutcomeUser` gate
// the session-chain decisions use: the desktop renderer, or a paired mobile/runtime
// device, and never a caller holding an orchestration capability or agent-session
// evidence.
//
// `list` is not a decision. Reading which prompts are waiting changes nothing and
// discloses nothing a local caller cannot already read out of the profile state
// file, so it admits any local caller that is not asserting agent authority — which
// is what lets `omni prompt-queue list` work. The capability/agent-session refusal is
// unchanged for reads: a dispatched worker still gets nothing here.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  conversationSourceRowKey,
  normalizeConversationSource
} from '../../../../shared/conversation-source'
import {
  emptyPromptQueue,
  PROMPT_QUEUE_MAX_TEXT_LENGTH,
  PROMPT_QUEUE_RPC,
  promptQueueWaitReason,
  type PromptQueue
} from '../../../../shared/prompt-queue-types'
import { enqueueConversationPrompt } from '../../prompt-queue-enqueue'
import {
  SESSION_CONTEXT_ENQUEUE_RPC,
  sameSessionContextQueueIdentity,
  sessionContextQueueIdentitySchema
} from '../../../../shared/session-context-queue'
import { prepareSessionContextQueueOrigin } from '../../prompt-queue-context-identity'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const ConversationSourceParams = z
  .object({
    worktreeId: requiredString('Missing workspace'),
    paneKey: requiredString('Missing conversation pane'),
    kind: z.enum(['pty', 'structured']),
    sessionId: z.string().min(1).max(512).optional()
  })
  .strict()

const SourceParams = z.object({ source: ConversationSourceParams }).strict()

const EnqueueParams = z
  .object({
    source: ConversationSourceParams,
    id: requiredString('Missing prompt id').pipe(z.string().max(200)),
    text: z.string().min(1).max(PROMPT_QUEUE_MAX_TEXT_LENGTH)
  })
  .strict()

const EntryParams = z
  .object({ source: ConversationSourceParams, entryId: requiredString('Missing prompt id') })
  .strict()

const ContextEnqueueParams = EnqueueParams.extend({
  identity: sessionContextQueueIdentitySchema
}).strict()

const ReorderParams = EntryParams.extend({ direction: z.enum(['up', 'down']) }).strict()

type SourceInput = z.infer<typeof ConversationSourceParams>

/**
 * A read is admitted for a local caller that asserts no agent authority.
 *
 * Why not `assertSessionOutcomeUser`: that gate requires a client identity only the
 * app's own renderer and paired devices carry. The local CLI reaches the runtime
 * over the Unix socket / named pipe, which dispatches with NO clientId, clientKind
 * or pairedDeviceId at all (`runtime-rpc-request-admission.ts` → `dispatcher.dispatch`),
 * so it can never satisfy it — and a person asking "what is queued?" is owed an
 * answer, not an authority error.
 */
function assertPromptQueueReader(context: RpcContext): void {
  if (context.orchestrationCapability || context.orchestrationCompatibilityEvidence) {
    throw new Error(
      'This decision requires the authenticated user interface, not an agent assertion.'
    )
  }
}

/** Refuses a source this build cannot address before anything is written. */
function admit(
  context: RpcContext,
  input: SourceInput,
  authority: (context: RpcContext) => void = assertSessionOutcomeUser
): { rowKey: string; queue: PromptQueue } {
  authority(context)
  const source = normalizeConversationSource(input)
  if (!source) {
    throw new Error('That conversation cannot be addressed on this host.')
  }
  const rowKey = conversationSourceRowKey(source)
  return {
    rowKey,
    queue: context.runtime.readPromptQueue(rowKey) ?? emptyPromptQueue(source)
  }
}

export const PROMPT_QUEUE_METHODS: RpcMethod[] = [
  defineMethod({
    name: PROMPT_QUEUE_RPC.list,
    params: SourceParams,
    handler: (params, context) => {
      const { queue } = admit(context, params.source, assertPromptQueueReader)
      const waitReason = promptQueueWaitReason(queue)
      return { queue, ...(waitReason ? { waitReason } : {}) }
    }
  }),
  defineMethod({
    name: PROMPT_QUEUE_RPC.enqueue,
    params: EnqueueParams,
    handler: (params, context) => {
      const { queue } = admit(context, params.source)
      return {
        queue: enqueueConversationPrompt(context.runtime, queue.source, {
          id: params.id,
          text: params.text
        })
      }
    }
  }),
  defineMethod({
    name: SESSION_CONTEXT_ENQUEUE_RPC,
    params: ContextEnqueueParams,
    handler: async (params, context) => {
      const { queue } = admit(context, params.source)
      // Return the receipt even after an uncertain response or a later receiver change.
      const existing = queue.entries.find((entry) => entry.id === params.id)
      if (existing) {
        if (
          existing.text !== params.text ||
          existing.origin?.kind !== 'session-context' ||
          !sameSessionContextQueueIdentity(existing.origin.identity, params.identity)
        ) {
          throw new Error('That context update id already belongs to another message.')
        }
        return { queue }
      }
      const origin = await prepareSessionContextQueueOrigin(
        context.runtime,
        queue.source,
        params.identity
      )
      return {
        queue: enqueueConversationPrompt(context.runtime, queue.source, {
          id: params.id,
          text: params.text,
          origin
        })
      }
    }
  }),
  defineMethod({
    name: PROMPT_QUEUE_RPC.remove,
    params: EntryParams,
    handler: (params, context) => {
      const { rowKey, queue } = admit(context, params.source)
      return { queue: context.runtime.removePromptQueueEntry(rowKey, params.entryId) ?? queue }
    }
  }),
  defineMethod({
    name: PROMPT_QUEUE_RPC.reorder,
    params: ReorderParams,
    handler: (params, context) => {
      const { rowKey, queue } = admit(context, params.source)
      return {
        queue:
          context.runtime.reorderPromptQueueEntry(rowKey, params.entryId, params.direction) ?? queue
      }
    }
  }),
  defineMethod({
    name: PROMPT_QUEUE_RPC.requeue,
    params: EntryParams,
    handler: (params, context) => {
      const { rowKey, queue } = admit(context, params.source)
      return {
        queue:
          context.runtime.requeuePromptQueueEntry(rowKey, params.entryId, {
            id: randomUUID(),
            createdAt: Date.now()
          }) ?? queue
      }
    }
  }),
  defineMethod({
    name: PROMPT_QUEUE_RPC.clearDelivered,
    params: SourceParams,
    handler: (params, context) => {
      const { rowKey, queue } = admit(context, params.source)
      return { queue: context.runtime.clearDeliveredPromptQueueEntries(rowKey) ?? queue }
    }
  })
]
