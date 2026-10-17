/**
 * Where a composed block goes, what is holding it, and which blocks a commit takes — all read
 * off the list the person saw.
 *
 * Questions the commit boundary has to answer from the VIEW rather than from the plan: which
 * stage a new one was put after (so the shown order is the executed order), which review is
 * still out (so what was composed behind it waits for those people instead of being refused or
 * queued ahead of them), and which of the composed blocks a caller NAMED. All pure readings;
 * nothing here writes.
 */

import type { SessionChain } from '../../shared/session-chain-types'
import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_REFUSAL_KEYS,
  type UpNextBlock,
  type UpNextPersonBlock,
  type UpNextView
} from '../../shared/up-next-types'
import type { UpNextCommitSelection } from './up-next-commit'
import { isUpNextDraftBlockId } from './up-next-draft-blocks'
import { upNextReviewOpen } from './up-next-person-facts'

/** A plan node id, from the block that stands for it. */
export function upNextPlanNodeOf(block: UpNextBlock): string | undefined {
  return block.id.startsWith(UP_NEXT_BLOCK_ID.planNode)
    ? block.id.slice(UP_NEXT_BLOCK_ID.planNode.length)
    : undefined
}

/**
 * The stage this draft was put AFTER: the nearest agent block above it.
 *
 * A queued block names its own plan node. A DRAFT above it is part of the same commit, so the
 * anchor is whatever node that draft just minted — `minted` is the commit loop's record of it,
 * keyed by draft block id. Without that record the plan's own order only happens to be right
 * for a draft appended at the END: two drafts anchored between the same pair of queued stages
 * lowered as A, C, B, D — the second one anchored to the last node in the plan instead of to
 * the sibling shown above it, and reading that stage's output instead of its sibling's.
 */
export function upNextAnchorNodeFor(
  view: UpNextView,
  block: UpNextBlock,
  minted: ReadonlyMap<string, string> = new Map()
): string | undefined {
  for (let index = view.blocks.indexOf(block) - 1; index >= 0; index -= 1) {
    const above = view.blocks[index]!
    if (above.kind !== 'agent') {
      continue
    }
    return isUpNextDraftBlockId(above.id) ? minted.get(above.id) : upNextPlanNodeOf(above)
  }
  return undefined
}

/**
 * The FIRST review this conversation is still waiting on: one the chain has already asked whose
 * reviewers have not all approved. Blocks composed after it are the host's to run when it
 * returns — they are not refused, and they are not queued ahead of the people who have not
 * said OK. A review that has come back holds nothing, and neither does one whose obligations
 * the chain has already spent: what follows it is ordinary work.
 *
 * The first and not the last, because everything behind a review waits for it — a SECOND review
 * nested behind one that is still out included. Taking the later of the two let a review composed
 * behind an open one become the gate, so the work between them ran while the first reviewers were
 * still reading.
 */
export function upNextOpenReviewIndex(view: UpNextView, chain: SessionChain | null): number {
  const open = view.blocks.find((block): block is UpNextPersonBlock => {
    if (
      block.kind !== 'person' ||
      block.relationship !== 'review' ||
      isUpNextDraftBlockId(block.id) ||
      !block.stepId
    ) {
      return false
    }
    return upNextReviewOpen(chain, block.stepId)
  })
  return open ? view.blocks.indexOf(open) : -1
}

/**
 * The step that owns the gate: the handoff authored for the people THIS block names, found by
 * who it asks rather than by being the last handoff in the chain. A same-reviewer second
 * review compiles no new step (`newWorkPlanHandoffs` never asks the same people twice), and an
 * earlier version's answered request must not be mistaken for the gate held blocks wait on.
 */
export function upNextReviewStepFor(
  chain: SessionChain | null,
  person: UpNextPersonBlock
): string | undefined {
  const asked = person.people
    .map((entry) => entry.id)
    .toSorted()
    .join(',')
  return chain?.steps.findLast(
    (step) =>
      step.kind === 'handoff' &&
      step.handoff.recipients
        .map((recipient) => recipient.employeeId)
        .toSorted()
        .join(',') === asked
  )?.id
}

/**
 * The blocks a caller NAMED, as a selection. A named block this conversation is not
 * composing is a stale id from a pane that queued it already; saying so is the only safe
 * answer, because the alternative queues the blocks the person is still writing.
 */
export function upNextNamedSelection(
  view: UpNextView,
  blockIds?: readonly string[]
): UpNextCommitSelection {
  if (!blockIds?.length) {
    return {}
  }
  const named = new Set(blockIds)
  const composed = view.blocks.filter(
    (block) => named.has(block.id) && isUpNextDraftBlockId(block.id)
  )
  if (composed.length !== named.size) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.unknownBlock)
  }
  // A prompt nested under a stage is delivered into THAT stage's own conversation, so a selection
  // that takes the prompt and leaves the stage composed has nowhere to put it: the prompt matched
  // no seat, was reported as committed anyway and then removed with the rest — the person's words
  // acknowledged and thrown away. It is refused instead, naming what is missing.
  if (
    composed.some(
      (block) =>
        block.kind === 'prompt' &&
        block.target.kind === 'stage' &&
        isUpNextDraftBlockId(block.target.blockId) &&
        !named.has(block.target.blockId)
    )
  ) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.promptNeedsItsStage)
  }
  return { only: (block) => named.has(block.id) }
}
