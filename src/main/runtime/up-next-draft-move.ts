/**
 * Where a composed row SITS, and where it lands when the person moves it.
 *
 * A draft is placed by its anchor — after a named block, pinned at the head, or nowhere,
 * which means the end — so moving one is a change of anchor, not a change of list order.
 * Crossing a queued block re-anchors it, which is how a prompt ends up under a different
 * stage ("now under 3 · Improve"); crossing another draft trades their placements, because
 * the placements are read BEFORE the list and a row that kept its own would not move.
 *
 * Pure on purpose: the caller owns the draft store, this owns the order rules.
 */

import { randomUUID } from 'node:crypto'
import type { UpNextDraftEntry } from '../../shared/up-next-draft-schema'
import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_REFUSAL_KEYS,
  type UpNextDraftInput,
  type UpNextView
} from '../../shared/up-next-types'
import { isUpNextDraftBlockId } from './up-next-draft-blocks'

/** Where a new block goes: at the head, after a named block, or at the end. */
export function upNextDraftEntryFor(
  input: UpNextDraftInput,
  place: { afterBlockId?: string; head?: boolean }
): UpNextDraftEntry {
  return {
    id: `${UP_NEXT_BLOCK_ID.draft}${randomUUID()}`,
    input,
    ...(place.head ? { place: 'head' as const } : {}),
    ...(!place.head && place.afterBlockId ? { afterBlockId: place.afterBlockId } : {}),
    createdAt: Date.now()
  }
}

/**
 * The same draft, anchored somewhere else — or nowhere, which means "at the end". The head
 * pin goes with the old anchor: it is read BEFORE anchors, so a draft that kept it would
 * stay at the top however far the person moved the row.
 */
function withAnchor(entry: UpNextDraftEntry, afterBlockId?: string): UpNextDraftEntry {
  const { afterBlockId: _previous, place: _pinned, ...rest } = entry
  return { ...rest, ...(afterBlockId ? { afterBlockId } : {}) }
}

/** Where the person put a draft: pinned at the head, after a block, or nowhere (the end). */
function placementOf(entry: UpNextDraftEntry): Pick<UpNextDraftEntry, 'place' | 'afterBlockId'> {
  return {
    ...(entry.place ? { place: entry.place } : {}),
    ...(entry.afterBlockId ? { afterBlockId: entry.afterBlockId } : {})
  }
}

/**
 * The draft list after one row moved one place, or null when the row has nowhere to go: the
 * caller REFUSES that move (`up-next-write.ts`) rather than writing an identical list back
 * and answering with an unchanged view. The view decides what "one place" means — it is the
 * list the person is looking at — so the neighbour is read from it, never from the store.
 */
export function upNextDraftsReordered(
  current: UpNextView,
  stored: readonly UpNextDraftEntry[],
  blockId: string,
  direction: -1 | 1
): UpNextDraftEntry[] | null {
  const entries = [...stored]
  const index = entries.findIndex((entry) => entry.id === blockId)
  if (index === -1) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.unknownBlock)
  }
  const position = current.blocks.findIndex((entry) => entry.id === blockId)
  const neighbour = current.blocks[position + direction]!
  if (isUpNextDraftBlockId(neighbour.id)) {
    const target = entries.findIndex((entry) => entry.id === neighbour.id)
    const moved = entries[index]!
    const other = entries[target]!
    entries[index] = { ...withAnchor(other), ...placementOf(moved) }
    entries[target] = { ...withAnchor(moved), ...placementOf(other) }
    return entries
  }
  if (direction === 1) {
    entries[index] = withAnchor(entries[index]!, neighbour.id)
    return entries
  }
  // Up across a queued block: the anchor is the last queued block STRICTLY above the
  // neighbour — the slice already stops before the neighbour, so that is its LAST entry.
  // Reading further back would move the row two positions, or none at all.
  const above = current.blocks
    .slice(0, position + direction)
    .findLast((entry) => !isUpNextDraftBlockId(entry.id))
  if (!above && entries[index]!.input.kind !== 'prompt') {
    // Nothing queued to anchor to, and only a prompt may be the next thing the current
    // agent hears: the row has nowhere higher to go, and the caller says so.
    return null
  }
  entries[index] = above
    ? withAnchor(entries[index]!, above.id)
    : { ...withAnchor(entries[index]!), place: 'head' as const }
  return entries
}
