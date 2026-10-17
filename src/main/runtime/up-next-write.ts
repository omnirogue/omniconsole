/**
 * Editing Up next: add, change, move, remove, discard, and "configure a stage after this".
 *
 * Every write is on the person's own composed blocks — their DRAFTS — or on a primitive
 * that already owns the thing being changed: a queued prompt is moved and removed by the
 * prompt queue, a prompt nested under a stage by that stage's seat, and a stage that is
 * already queued is re-planned by the plan engine, which refuses while any of its work is
 * in flight. A running stage is therefore never mutated here: it is followed by a copy
 * (`configureAfter`), exactly as v3 amendment 1 requires.
 */

import type { SessionFinishChoice } from '../../shared/session-finish-intent'
import { upNextBlockPatchSchema, type UpNextDraftEntry } from '../../shared/up-next-draft-schema'
import { upNextChangeRefusal, upNextIsEndCap } from '../../shared/up-next-order'
import { upNextSendAboveQueued } from '../../shared/up-next-person-send'
import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_REASON_KEYS,
  UP_NEXT_REFUSAL_KEYS,
  upNextIsFinished,
  upNextRowKey,
  type UpNextAgentBlock,
  type UpNextAppendPosition,
  type UpNextBlock,
  type UpNextBlockPatch,
  type UpNextConversationId,
  type UpNextDoneBlock,
  type UpNextDraftInput,
  type UpNextView
} from '../../shared/up-next-types'
import { upNextView } from './up-next'
import {
  upNextCommitDrafts,
  upNextCommitFinish,
  upNextNamedSelection,
  type UpNextCommitContext
} from './up-next-commit'
import { upNextDraftsAfterCommit } from './up-next-continuation'
import { isUpNextDraftBlockId } from './up-next-draft-blocks'
import { upNextDraftEntryFor, upNextDraftsReordered } from './up-next-draft-move'
import { upNextWithdrawFinish } from './up-next-finish-withdraw'
import { upNextRemoveStagePrompt, upNextReorderStagePrompt } from './up-next-stage-prompt-move'
import {
  upNextHoldBehindReview,
  upNextRecommitWithout,
  upNextRecommitMoved
} from './up-next-plan-move'

export type UpNextWriteContext = UpNextCommitContext

const view = (ctx: UpNextWriteContext): Promise<UpNextView> =>
  upNextView(ctx.runtime, ctx.conversationId)

function drafts(ctx: UpNextWriteContext): UpNextDraftEntry[] {
  return [...(ctx.runtime.readUpNextDrafts(ctx.rowKey)?.entries ?? [])]
}

function save(ctx: UpNextWriteContext, entries: readonly UpNextDraftEntry[]): void {
  ctx.runtime.replaceUpNextDrafts(ctx.conversationId, entries)
}

function blockOf(current: UpNextView, blockId: string): UpNextBlock {
  const block = current.blocks.find((entry) => entry.id === blockId)
  if (!block) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.unknownBlock)
  }
  return block
}

export type UpNextAppendOptions = {
  /** `head` = the next thing the current agent hears, ahead of every queued stage. */
  position?: UpNextAppendPosition
  /** Put it directly after this block; ignored when the position is the head. */
  insertAfterBlockId?: string
}

export async function upNextAppend(
  ctx: UpNextWriteContext,
  draft: UpNextDraftInput,
  options: UpNextAppendOptions = {}
): Promise<UpNextView> {
  const current = await view(ctx)
  // A finished run takes nothing at all — not even at the head, and whether or not its session
  // was also closed. The head bypass below is about what may follow an END CAP; a finished run is
  // not a cap, and `canAdd` is where that rule lives for every other position.
  if (upNextIsFinished(current.header.state)) {
    throw new Error(UP_NEXT_REASON_KEYS.sessionClosed)
  }
  // A block at the HEAD goes to the agent that is working now, so the rules about what may
  // follow a handoff or Done — which are about the END of the track — do not apply to it.
  const head = options.position === 'head' && draft.kind === 'prompt'
  if (!head && !current.canAdd[draft.kind]) {
    throw new Error(current.canAdd.reasons[draft.kind] ?? UP_NEXT_REFUSAL_KEYS.pastTerminal)
  }
  const named =
    options.insertAfterBlockId ?? (draft.kind === 'prompt' ? draft.targetBlockId : undefined)
  const after = named ? current.blocks.findIndex((block) => block.id === named) : -1
  // A send placed ahead of queued work would be asked after it ran (`upNextSendAboveQueued`).
  if (
    after !== -1 &&
    upNextSendAboveQueued(
      { id: UP_NEXT_BLOCK_ID.draft, kind: draft.kind },
      current.blocks.slice(after + 1)
    )
  ) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.sendAfterQueued)
  }
  save(ctx, [
    ...drafts(ctx),
    upNextDraftEntryFor(draft, {
      head,
      ...(named ? { afterBlockId: blockOf(current, named).id } : {})
    })
  ])
  return view(ctx)
}

/** Editing a queued stage is not a thing: a new stage after it is (amendment 1). */
export async function upNextUpdate(
  ctx: UpNextWriteContext,
  blockId: string,
  patch: UpNextBlockPatch
): Promise<UpNextView> {
  const current = await view(ctx)
  const block = blockOf(current, blockId)
  if (block.kind !== patch.kind) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.wrongKind)
  }
  if (!isUpNextDraftBlockId(blockId)) {
    // The one queued block a person may still change is Done: how a session finishes is
    // not a plan change, so it goes through the outcome commit as itself.
    if (block.kind === 'done' && patch.kind === 'done') {
      await commitFinishPatch(ctx, block, patch)
      return view(ctx)
    }
    throw new Error(
      block.locked ? UP_NEXT_REFUSAL_KEYS.blockRunning : UP_NEXT_REFUSAL_KEYS.blockQueued
    )
  }
  const entries = drafts(ctx)
  const index = entries.findIndex((entry) => entry.id === blockId)
  // Why this edit is refused, in one place: a block that is no longer composed, or a change
  // that would bury work behind the end of the track (`upNextChangeRefusal`).
  const refusal =
    index === -1
      ? UP_NEXT_REFUSAL_KEYS.unknownBlock
      : upNextChangeRefusal(current.blocks, blockId, patch)
  if (refusal) {
    throw new Error(refusal)
  }
  const { kind: _kind, ...changes } = upNextBlockPatchSchema.parse(patch)
  entries[index] = {
    ...entries[index]!,
    input: { ...entries[index]!.input, ...changes } as UpNextDraftInput
  }
  save(ctx, entries)
  return view(ctx)
}

/** How a queued session finishes is not a plan change: it commits as itself. */
async function commitFinishPatch(
  ctx: UpNextWriteContext,
  block: UpNextDoneBlock,
  patch: Extract<UpNextBlockPatch, { kind: 'done' }>
): Promise<void> {
  if (block.locked) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.doneQueued)
  }
  await upNextCommitFinish(ctx, {
    ...block,
    finish: patch.finish ?? block.finish,
    ...(patch.folderId ? { folderId: patch.folderId } : {})
  })
}

export async function upNextRemove(ctx: UpNextWriteContext, blockId: string): Promise<UpNextView> {
  const current = await view(ctx)
  const block = blockOf(current, blockId)
  if (isUpNextDraftBlockId(blockId)) {
    save(
      ctx,
      drafts(ctx).filter((entry) => entry.id !== blockId)
    )
    return view(ctx)
  }
  if (blockId.startsWith(UP_NEXT_BLOCK_ID.promptQueue)) {
    ctx.runtime.removePromptQueueEntry(
      ctx.rowKey,
      blockId.slice(UP_NEXT_BLOCK_ID.promptQueue.length)
    )
    return view(ctx)
  }
  if (blockId.startsWith(UP_NEXT_BLOCK_ID.stagePrompt)) {
    upNextRemoveStagePrompt(ctx, blockId)
    return view(ctx)
  }
  if (block.locked) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.blockRunning)
  }
  if (block.kind === 'done') {
    // A Done that has not executed is exactly as un-launched as any other queued block, and
    // the add gate tells the person to remove it before anything else may be added. So it is
    // withdrawn — the finish INTENT is cleared — rather than refused for being queued.
    await upNextWithdrawFinish(ctx)
    return view(ctx)
  }
  await upNextRecommitWithout(ctx, block)
  return view(ctx)
}

export async function upNextReorder(
  ctx: UpNextWriteContext,
  blockId: string,
  direction: -1 | 1
): Promise<UpNextView> {
  const current = await view(ctx)
  const block = blockOf(current, blockId)
  const index = current.blocks.findIndex((entry) => entry.id === blockId)
  const neighbour = current.blocks[index + direction]
  if (upNextIsEndCap(block)) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.capIsTerminal)
  }
  if (!neighbour || (direction === 1 && upNextIsEndCap(neighbour))) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
  }
  if (block.locked || neighbour.locked) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.blockRunning)
  }
  if (isUpNextDraftBlockId(blockId)) {
    // Up past queued work puts that work below the send, where it would still run first.
    if (direction === -1 && upNextSendAboveQueued(block, [neighbour])) {
      throw new Error(UP_NEXT_REFUSAL_KEYS.sendAfterQueued)
    }
    const moved = upNextDraftsReordered(current, drafts(ctx), blockId, direction)
    // Nowhere higher to go: only a PROMPT may be the next thing the current agent hears, so a
    // stage, a person or a Done above the first queued block has no anchor left to take. The
    // move is refused rather than answered with an identical view — the same honesty the
    // prompt queue already owes below (U-22): an enabled control acts, or it says why.
    if (!moved) {
      throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    }
    save(ctx, moved)
    return view(ctx)
  }
  if (blockId.startsWith(UP_NEXT_BLOCK_ID.stagePrompt)) {
    upNextReorderStagePrompt(ctx, blockId, neighbour.id, direction)
    return view(ctx)
  }
  if (blockId.startsWith(UP_NEXT_BLOCK_ID.promptQueue)) {
    // The queue reorders among ITSELF, and its entries always render above the plan. Asking
    // it to swap with a stage, a draft or a failed entry moves nothing at all, so the move is
    // refused instead of answered with an identical view.
    if (!neighbour.id.startsWith(UP_NEXT_BLOCK_ID.promptQueue) || neighbour.state !== 'queued') {
      throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    }
    ctx.runtime.reorderPromptQueueEntry(
      ctx.rowKey,
      blockId.slice(UP_NEXT_BLOCK_ID.promptQueue.length),
      direction === -1 ? 'up' : 'down'
    )
    return view(ctx)
  }
  if (block.kind === 'person' && direction === -1) {
    // A handoff and a Done are caps and were refused above, so this is a queued Review being
    // put EARLIER: the stage above it becomes work held behind the review.
    await upNextHoldBehindReview(ctx, block, neighbour)
    return view(ctx)
  }
  await upNextRecommitMoved(ctx, block, direction)
  return view(ctx)
}

/**
 * Throws away what has not been queued. What a review is HOLDING is not a draft: the host
 * owns it and commits it when the reviewers reply, so it survives this — the link says
 * "discard drafts", and queued work is not the person's to lose by pressing it.
 */
export async function upNextDiscardDrafts(ctx: UpNextWriteContext): Promise<UpNextView> {
  save(
    ctx,
    drafts(ctx).filter((entry) => entry.held)
  )
  return view(ctx)
}

/** A copy of a stage, as a new draft after it. The running one is never touched. */
export async function upNextConfigureAfter(
  ctx: UpNextWriteContext,
  blockId: string
): Promise<UpNextView> {
  const current = await view(ctx)
  const block = blockOf(current, blockId)
  if (block.kind !== 'agent') {
    throw new Error(UP_NEXT_REFUSAL_KEYS.wrongKind)
  }
  const copy: UpNextAgentBlock = block
  save(ctx, [
    ...drafts(ctx),
    upNextDraftEntryFor(
      {
        kind: 'agent',
        template: copy.template,
        shape: copy.shape,
        n: copy.n,
        ...(copy.instruction ? { instruction: copy.instruction } : {}),
        advanced: copy.advanced
      },
      { afterBlockId: blockId }
    )
  ])
  return view(ctx)
}

/**
 * What one commit leaves behind: the chain as it now stands, and a finish this host could not
 * perform. A Done block on a conversation that never became a pursuit has no outcome set to
 * record the intent on and none is manufactured for it (frozen model, invariants 2 and 10), so
 * the choice is handed back for the SURFACE's own finish door to carry out.
 */
export type UpNextCommitOutcome = { view: UpNextView; finish?: SessionFinishChoice }

/**
 * Queues what was composed — everything, or only the blocks the caller NAMES.
 *
 * `blockIds` is what lets `/next <prompt>` queue itself the moment it is typed without
 * taking the half-written blocks beside it: the command appends its prompt and then names
 * that one block. `adoptFrom` is how blocks written on an unstarted thread or card follow
 * it into the conversation its own surface started: the drafts move to this conversation
 * first, then queue as if they had been written here.
 */
export async function upNextCommit(
  ctx: UpNextWriteContext,
  options: { adoptFrom?: UpNextConversationId; blockIds?: readonly string[] } = {}
): Promise<UpNextCommitOutcome> {
  if (options.adoptFrom) {
    const from = upNextRowKey(options.adoptFrom)
    const adopted = ctx.runtime.readUpNextDrafts(from)?.entries ?? []
    if (adopted.length) {
      save(ctx, [...drafts(ctx), ...adopted])
      ctx.runtime.replaceUpNextDrafts(options.adoptFrom, [])
    }
  }
  const current = await view(ctx)
  const result = await upNextCommitDrafts(
    ctx,
    current,
    upNextNamedSelection(current, options.blockIds)
  )
  // The plan is already on disk synchronously; this write finishes the same commit, so it
  // goes to disk with it. A debounce here is a restart that resurrects executed work as
  // drafts and drops the review's own continuation marker.
  ctx.runtime.replaceUpNextDraftsAndFlush(
    ctx.conversationId,
    upNextDraftsAfterCommit(drafts(ctx), result, Date.now())
  )
  return { view: await view(ctx), ...(result.finish ? { finish: result.finish } : {}) }
}
