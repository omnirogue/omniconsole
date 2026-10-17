// The owner-level half of reconciling a paired owner's conversation ledger on this receiver
// (session parity, step 5), pure: the message a set or delta reconciles buckets by, and the owner
// entry (state, ordering, catalog, tombstones) once one is taken.

import type {
  MirroredConversationOwner,
  MirroredConversationOwnerState
} from '@/store/slices/mirrored-conversation-ledger'
import {
  readSessionConversationRemovalList,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationLedgerDelta
} from '../../../shared/session-conversation-ledger'
import type { MirroredConversationMessage } from './mirrored-conversation-ledger-reconcile'

/** An owner entry that knows nothing yet but its state. */
export function emptyMirroredConversationOwner(
  environmentId: string,
  state: MirroredConversationOwnerState
): MirroredConversationOwner {
  return {
    environmentId,
    state,
    asOf: null,
    generation: null,
    revision: null,
    source: null,
    listedAt: null,
    folders: [],
    projects: [],
    omitted: { unknownHost: 0, unverified: 0 },
    removals: []
  }
}

export function mirroredConversationSetMessage(
  set: RuntimeSessionConversationLedger
): MirroredConversationMessage {
  return {
    kind: 'set',
    generation: set.generation,
    revision: set.revision,
    source: set.source,
    listedAt: set.listedAt,
    coverage: set.coverage,
    recordsByWorktree: set.recordsByWorktree,
    removals: set.removals
  }
}

export function mirroredConversationDeltaMessage(
  delta: RuntimeSessionConversationLedgerDelta
): MirroredConversationMessage {
  return {
    kind: 'delta',
    generation: delta.generation,
    revision: delta.revision,
    source: delta.source,
    listedAt: null,
    coverage: delta.coverage,
    recordsByWorktree: delta.changedByWorktree,
    removals: delta.removals ?? []
  }
}

/** The owner entry once a set (or a restored snapshot) is taken: its catalog replaces all. */
export function mirroredConversationOwnerFromSet(
  environmentId: string,
  set: RuntimeSessionConversationLedger,
  entry: { state: MirroredConversationOwnerState; asOf: number; ownerHostId?: string }
): MirroredConversationOwner {
  const { state, asOf, ownerHostId } = entry
  return {
    environmentId,
    state,
    asOf,
    generation: set.generation,
    revision: set.revision,
    source: set.source,
    listedAt: set.listedAt,
    folders: set.folders,
    projects: set.projects,
    omitted: set.omitted,
    removals: set.removals,
    ...(set.removalsTruncated ? { removalsTruncated: true as const } : {}),
    ...(ownerHostId ? { ownerHostId } : {})
  }
}

/**
 * The owner entry once a delta is taken: folders and projects only when it carries them (absent
 * is unchanged, A4), its removals joining the retained list (it carries only those since its base),
 * and "as of" the receipt time (a delta has no listedAt).
 */
export function mirroredConversationOwnerFromDelta(
  previous: MirroredConversationOwner,
  delta: RuntimeSessionConversationLedgerDelta,
  asOf: number
): MirroredConversationOwner {
  const removals = delta.removals?.length
    ? readSessionConversationRemovalList([...previous.removals, ...delta.removals])
    : { removals: previous.removals, truncated: false }
  return {
    environmentId: previous.environmentId,
    state: 'ready',
    asOf,
    generation: delta.generation,
    revision: delta.revision,
    source: delta.source,
    listedAt: previous.listedAt,
    folders: delta.folders ?? previous.folders,
    projects: delta.projects ?? previous.projects,
    omitted: previous.omitted,
    removals: removals.removals,
    ...(delta.removalsTruncated || removals.truncated ? { removalsTruncated: true as const } : {}),
    ...(previous.ownerHostId ? { ownerHostId: previous.ownerHostId } : {})
  }
}
