// `upNext.*` — the one ordered chain of everything scheduled on one conversation.
//
// Reading it is not a decision: the chain is already on disk (the prompt queue in the
// profile state file, the plan in its session chain), so `list` admits any local
// caller that is not asserting agent authority — which is what lets `omni`/`/queue`
// show a person what is waiting. A caller holding an orchestration capability or
// agent-session evidence gets nothing at all, read included.
//
// Every WRITE is a decision the person makes at their own interface: adding a stage,
// reordering it, committing it, finishing the session. They all go through
// `assertSessionOutcomeUser`, the same gate `promptQueue.*` and the session-chain
// commits use (#367), so the desktop renderer or a paired device may write and the
// CLI, an agent and a dispatched worker may not — with the same wording.
//
// No write here invents an engine. A draft is a durable intention; committing it is
// `commitWorkPlan` (one Outcome, one plan version) for stages and the person,
// `promptQueue.enqueue` for a prompt to the current agent, the stage's own prompt list
// for a prompt to a stage, and the outcome set's finish intent for Done.

import { randomUUID } from 'node:crypto'
import { normalizeConversationSource } from '../../../../shared/conversation-source'
import { upNextSubjectSchema } from '../../../../shared/up-next-draft-schema'
import {
  isUpNextConversation,
  UP_NEXT_BLOCK_ID,
  UP_NEXT_RPC,
  upNextRowKey,
  type UpNextConversationId,
  type UpNextView
} from '../../../../shared/up-next-types'
import { assertSessionOutcomeUser } from '../../session-outcome-authority'
import {
  assertSessionOutcomeRuntime,
  sessionOutcomeLocalWorkspace
} from '../../session-outcome-host-boundary'
import { upNextView } from '../../up-next'
import {
  upNextAppend,
  upNextCommit,
  upNextConfigureAfter,
  upNextDiscardDrafts,
  upNextRemove,
  upNextReorder,
  upNextUpdate,
  type UpNextWriteContext
} from '../../up-next-write'
import { defineMethod, type RpcContext, type RpcMethod } from '../core'
import { UP_NEXT_PARAMS, type UpNextConversationParams } from './up-next-schemas'

/**
 * A read is admitted for a local caller that asserts no agent authority — the same
 * rule, and the same reasoning, as `assertPromptQueueReader`: the CLI reaches the
 * runtime over the socket with no client identity at all, and a person asking "what is
 * up next?" is owed an answer rather than an authority error.
 */
function assertUpNextReader(context: RpcContext): void {
  if (context.orchestrationCapability || context.orchestrationCompatibilityEvidence) {
    throw new Error(
      'This decision requires the authenticated user interface, not an agent assertion.'
    )
  }
}

/**
 * Refuses a subject this build cannot address before anything is read or written. A
 * conversation must be addressable on this host; a thread and a card are their own names.
 */
async function addressed(
  context: RpcContext,
  params: UpNextConversationParams,
  authority: (context: RpcContext) => void
): Promise<UpNextConversationId> {
  authority(context)
  assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
  const subject = upNextSubjectSchema.safeParse(params.conversationId)
  // A conversation must be addressable on this host — a chat pane with no session to send
  // to is refused here, in words, before anything is read or written.
  if (
    !subject.success ||
    (isUpNextConversation(subject.data) && !normalizeConversationSource(subject.data))
  ) {
    throw new Error('That conversation cannot be addressed on this host.')
  }
  if (context.pairedDeviceId && isUpNextConversation(subject.data)) {
    await sessionOutcomeLocalWorkspace(context.runtime, subject.data.worktreeId)
    assertSessionOutcomeRuntime(context, params.expectedExecutionRuntimeId)
  }
  return subject.data
}

async function read(
  context: RpcContext,
  params: UpNextConversationParams
): Promise<{ view: UpNextView }> {
  const source = await addressed(context, params, assertUpNextReader)
  return { view: await upNextView(context.runtime, source) }
}

/** Admits the person's own interface, then names the conversation every write is about. */
async function writer(
  context: RpcContext,
  params: UpNextConversationParams
): Promise<UpNextWriteContext> {
  const source = await addressed(context, params, assertSessionOutcomeUser)
  return { runtime: context.runtime, conversationId: source, rowKey: upNextRowKey(source) }
}

/** "Queue again" on a failed queued prompt; the entry's own store write says why it cannot. */
function requeue(ctx: UpNextWriteContext, blockId: string): Promise<UpNextView> {
  if (!blockId.startsWith(UP_NEXT_BLOCK_ID.promptQueue)) {
    throw new Error('Only a queued prompt can be queued again.')
  }
  ctx.runtime.requeuePromptQueueEntry(
    ctx.rowKey,
    blockId.slice(UP_NEXT_BLOCK_ID.promptQueue.length),
    { id: randomUUID(), createdAt: Date.now() }
  )
  return upNextView(ctx.runtime, ctx.conversationId)
}

const wrote = async (view: Promise<UpNextView>): Promise<{ view: UpNextView }> => ({
  view: await view
})

export const UP_NEXT_METHODS: RpcMethod[] = [
  defineMethod({
    name: UP_NEXT_RPC.list,
    params: UP_NEXT_PARAMS.list,
    handler: (params, context) => read(context, params)
  }),
  defineMethod({
    name: UP_NEXT_RPC.append,
    params: UP_NEXT_PARAMS.append,
    handler: async (params, context) =>
      wrote(
        upNextAppend(await writer(context, params), params.draft, {
          ...(params.position ? { position: params.position } : {}),
          ...(params.insertAfterBlockId ? { insertAfterBlockId: params.insertAfterBlockId } : {})
        })
      )
  }),
  defineMethod({
    name: UP_NEXT_RPC.update,
    params: UP_NEXT_PARAMS.update,
    handler: async (params, context) =>
      wrote(upNextUpdate(await writer(context, params), params.blockId, params.patch))
  }),
  defineMethod({
    name: UP_NEXT_RPC.reorder,
    params: UP_NEXT_PARAMS.reorder,
    handler: async (params, context) =>
      wrote(upNextReorder(await writer(context, params), params.blockId, params.direction))
  }),
  defineMethod({
    name: UP_NEXT_RPC.remove,
    params: UP_NEXT_PARAMS.remove,
    handler: async (params, context) =>
      wrote(upNextRemove(await writer(context, params), params.blockId))
  }),
  defineMethod({
    name: UP_NEXT_RPC.commit,
    params: UP_NEXT_PARAMS.commit,
    // The one write that answers with more than the view: a Done on a conversation that never
    // became a pursuit is finished by the SURFACE, so its choice is handed back to the caller
    // that owns the conversation (`finishNextStep`). Nothing is manufactured here to absorb it.
    handler: async (params, context) =>
      upNextCommit(await writer(context, params), {
        ...(params.adoptFrom ? { adoptFrom: params.adoptFrom } : {}),
        ...(params.blockIds ? { blockIds: params.blockIds } : {})
      })
  }),
  defineMethod({
    name: UP_NEXT_RPC.discardDrafts,
    params: UP_NEXT_PARAMS.discardDrafts,
    handler: async (params, context) => wrote(upNextDiscardDrafts(await writer(context, params)))
  }),
  defineMethod({
    name: UP_NEXT_RPC.configureAfter,
    params: UP_NEXT_PARAMS.configureAfter,
    handler: async (params, context) =>
      wrote(upNextConfigureAfter(await writer(context, params), params.blockId))
  }),
  defineMethod({
    name: UP_NEXT_RPC.requeue,
    params: UP_NEXT_PARAMS.requeue,
    handler: async (params, context) =>
      wrote(requeue(await writer(context, params), params.blockId))
  })
]
