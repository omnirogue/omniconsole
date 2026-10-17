/**
 * The one choice "Send to a person" offers — "Wait for their OK before my next steps run" — read
 * the same way by the composer that shows it and the host that commits it.
 *
 * Ticked is a review: the blocks after it are held until every named person says OK. Unticked is
 * a hand off: it becomes theirs, and the track ends at the send. A composed block nobody has ticked
 * or unticked yet stores no relationship and reads as the owner's default — it waits exactly when
 * a step it can hold follows it (`upNextStepsAfter`). The choice is stored only when the person
 * touches the box, which is what keeps the box from ever changing by itself after that.
 */

import {
  UP_NEXT_BLOCK_ID,
  type UpNextBlock,
  type UpNextBlockKind,
  type UpNextBlockState,
  type UpNextPersonRelationship
} from './up-next-types'

/** The least a block must say for the choice to be read: its kind, state and relationship. */
export type UpNextSendBlock = {
  kind: UpNextBlockKind
  state?: UpNextBlockState
  relationship?: UpNextPersonRelationship
  /** The review a composed block is already held behind; held work is still the person's. */
  heldFor?: { blockId: string }
}

/**
 * The "N next steps" a sentence names: the blocks after the one at `index` that its commit can
 * hold — still composed, or already held behind a review. Work that is queued or running runs
 * whatever the send says, because the people are the plan's own finish, so it is never counted.
 */
export function upNextStepsAfter(blocks: readonly UpNextSendBlock[], index: number): number {
  return blocks
    .slice(index + 1)
    .filter((block) => block.state === 'draft' || block.heldFor !== undefined).length
}

/**
 * Whether a composed send would sit ABOVE work already queued. The people are the plan's finish,
 * so that work would run before they are even asked, and the order the track showed could never
 * happen. Moving a send up past such a block, or inserting one ahead of it, is refused for the
 * same reason stopping the wait over it is (`upNextChangeRefusal`). Held work is still composed.
 */
export function upNextSendAboveQueued(
  send: { id: string; kind: UpNextBlockKind },
  below: readonly { id: string }[]
): boolean {
  const composed = (block: { id: string }): boolean => block.id.startsWith(UP_NEXT_BLOCK_ID.draft)
  return send.kind === 'person' && composed(send) && below.some((block) => !composed(block))
}

/** Whether the Person block at `index` waits for its people's OK before the rest runs. */
export function upNextSendWaits(blocks: readonly UpNextSendBlock[], index: number): boolean {
  const block = blocks[index]
  if (block?.kind !== 'person') {
    return false
  }
  if (block.relationship) {
    return block.relationship === 'review'
  }
  return upNextStepsAfter(blocks, index) > 0
}

/**
 * The steps a WAITING send pauses: those its commit holds, which stop at the next send that does
 * not wait. That send is held with them, but it ends the track, so nothing after it is paused.
 */
export function upNextStepsPausedBy(blocks: readonly UpNextSendBlock[], index: number): number {
  const end = blocks.findIndex(
    (block, at) => at > index && block.kind === 'person' && !upNextSendWaits(blocks, at)
  )
  return upNextStepsAfter(end === -1 ? blocks : blocks.slice(0, end + 1), index)
}

/** Where the track ends at a send that does not wait, or -1 when none does. */
export function upNextSendEnd(blocks: readonly UpNextSendBlock[]): number {
  return blocks.findIndex(
    (block, index) => block.kind === 'person' && !upNextSendWaits(blocks, index)
  )
}

/**
 * A composed block behind a send that does not wait. It is never committed from there — it stays
 * the person's draft, to move above the send or delete — because a hand off ends the track.
 */
export function upNextWontRun(blocks: readonly UpNextSendBlock[], index: number): boolean {
  const end = upNextSendEnd(blocks)
  return end !== -1 && index > end && blocks[index]?.state === 'draft'
}

/** The blocks with every untouched Person block's default written out, as the host commits it. */
export function upNextWithSendChoices(blocks: readonly UpNextBlock[]): UpNextBlock[] {
  return blocks.map((block, index) =>
    block.kind === 'person' && !block.relationship
      ? { ...block, relationship: upNextSendWaits(blocks, index) ? 'review' : 'handoff' }
      : block
  )
}
