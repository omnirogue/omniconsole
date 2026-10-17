import { upNextIsEndCap } from '../../../../shared/up-next-order'
import { upNextSendAboveQueued } from '../../../../shared/up-next-person-send'
import {
  UP_NEXT_BLOCK_ID,
  isUpNextConversation,
  upNextIsStoppedStage,
  type UpNextBlock,
  type UpNextView
} from '../../../../shared/up-next-types'

/** The pane of the conversation a track belongs to; a card or a thread has none yet. */
export function ownPaneKey(view: UpNextView): string | null {
  return isUpNextConversation(view.conversationId) ? view.conversationId.paneKey : null
}

/**
 * A composed row with nowhere higher to go. A draft is placed by its ANCHOR, and only a
 * prompt may be pinned ahead of the plan as the next thing the current agent hears, so a
 * stage, a person or a Done whose neighbour above is the first queued block has no anchor
 * left to take. The engine refuses that move (`up-next-write.ts`); the control says so
 * first, rather than offering a press that can only fail.
 */
export function stuckAboveTheQueue(view: UpNextView, block: UpNextBlock, index: number): boolean {
  const queued = (item: UpNextBlock | undefined): boolean =>
    Boolean(item) && !item!.id.startsWith(UP_NEXT_BLOCK_ID.draft)
  if (!block.id.startsWith(UP_NEXT_BLOCK_ID.draft) || block.kind === 'prompt') {
    return false
  }
  return queued(view.blocks[index - 1]) && !view.blocks.slice(0, index - 1).some(queued)
}

/**
 * A stage's prompt moves inside its own stage and nowhere else: the engine refuses a
 * neighbour outside it (`up-next-stage-prompt-move.ts`), and the refusal it answers with —
 * "nothing can be placed after the end of the track" — is not even about this row. Same
 * shape as the prompt queue's rule beside it: a control that cannot act is off.
 */
export function outsideItsStage(block: UpNextBlock, neighbour: UpNextBlock | undefined): boolean {
  if (!block.id.startsWith(UP_NEXT_BLOCK_ID.stagePrompt)) {
    return false
  }
  const seat = block.id.slice(0, block.id.lastIndexOf(':') + 1)
  return !neighbour?.id.startsWith(seat)
}

/**
 * The one move a queued Review has, and the one it does not.
 *
 * The people are the plan's finish, so nothing the plan carries sits below them: ↓ is not a
 * move at all (putting composed work before them is THAT row's own ↑). ↑ takes the queued
 * STAGE above it and holds that stage behind the review (`up-next-plan-move.ts`), so a row
 * above that is not a queued stage — a prompt of one, or something still being composed — is
 * not a move either. A handoff and Done are caps and have no arrows at all.
 */
export function personRowStaysPut(block: UpNextBlock, above: UpNextBlock | undefined): boolean {
  const composing = (item: UpNextBlock): boolean => item.id.startsWith(UP_NEXT_BLOCK_ID.draft)
  if (block.kind !== 'person' || composing(block)) {
    return false
  }
  return !above || above.kind !== 'agent' || composing(above)
}

/** A row the person may still move or remove: not launched, not locked. */
export function editableRow(item: UpNextBlock | undefined): boolean {
  return Boolean(item && !item.locked && ['draft', 'queued', 'waiting'].includes(item.state))
}

/**
 * The fix hint hands the next move to the person, so it shows only when the move IS theirs: an
 * honest failure nothing will retry, or a request that asks them to decide. A recovering or
 * waiting run fixes itself, and any other request already says exactly what to do.
 */
export function offersFixHint(view: UpNextView): boolean {
  return (
    view.header.state === 'failed' ||
    (view.header.state === 'needs-you' &&
      (view.header.attention ?? []).some((request) => request.kind === 'decision'))
  )
}

/** The stage that is the Now row and has stopped: the one row that opens by itself. */
export function stoppedNowId(view: UpNextView | null | undefined): string | null {
  const now = view?.now
  if (!view || !now || now.kind !== 'stage') {
    return null
  }
  const stage = view.blocks.find((block) => block.id === now.blockId)
  return stage && upNextIsStoppedStage(stage) ? stage.id : null
}

/**
 * One STOP, not one stage: a stage that stops, is folded, retries and stops again keeps its id,
 * so the fold is remembered against the stop's own timestamp and the new stop opens again.
 */
export function stopKey(block: UpNextBlock): string {
  return `${block.id}:${block.kind === 'agent' ? (block.progress?.stoppedAt ?? '') : ''}`
}

/**
 * Idle with nothing composed: the Now row and the dashed slot already say it all, so the ghost
 * end-cap row, "Nothing queued." and a disabled "Up to date" would only restate the one fact
 * (brief 78 #2). Busy-and-empty keeps amendment 1's three-row shape: the agent is doing
 * something, and the ghost row says what happens after it.
 */
export function idleEmpty(view: UpNextView): boolean {
  return view.now.kind === 'idle' && view.blocks.length === 0
}

/**
 * Whether a row's ↑ and ↓ are off, from every rule above at once: a neighbour that cannot be
 * crossed, a queued prompt that may only swap with another queued prompt, a stage prompt
 * outside its stage, a composed row stuck under the queue, and a Review that stays put.
 */
export function rowMoveDisabled(
  view: UpNextView,
  block: UpNextBlock,
  index: number
): { up: boolean; down: boolean } {
  const before = view.blocks[index - 1]
  const after = view.blocks[index + 1]
  const queuedPrompt = block.id.startsWith('pq:')
  const swapsWithQueued = (item: UpNextBlock | undefined): boolean =>
    Boolean(item?.id.startsWith('pq:') && item.state === 'queued')
  return {
    up:
      !editableRow(before) ||
      (queuedPrompt && !swapsWithQueued(before)) ||
      outsideItsStage(block, before) ||
      stuckAboveTheQueue(view, block, index) ||
      personRowStaysPut(block, before) ||
      upNextSendAboveQueued(block, before ? [before] : []),
    down:
      !editableRow(after) ||
      Boolean(after && upNextIsEndCap(after)) ||
      (queuedPrompt && !swapsWithQueued(after)) ||
      outsideItsStage(block, after) ||
      personRowStaysPut(block, undefined)
  }
}
