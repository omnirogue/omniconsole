// Owner-level transitions of a paired owner's conversation ledger on this receiver (session
// parity, step 5): it can no longer vouch for its rows (`older`, `unreachable`), its durable
// snapshot is restored at startup (`stale`), or its environment leaves the saved list. None of
// them removes a row the owner still lists, and none acts on a conversation.

import {
  mirroredConversationBucketState,
  type MirroredConversationBucket
} from '@/store/slices/mirrored-conversation-ledger'
import type { RuntimeSessionConversationLedger } from '../../../shared/session-conversation-ledger'
import {
  emptyMirroredConversationOwner,
  mirroredConversationOwnerFromSet
} from './mirrored-conversation-ledger-entry'
import {
  countMirroredConversationRecords,
  logMirroredConversationLedger,
  mirroredLedgerOrderByEnvironment,
  mirroredLedgerRetiredGenerations,
  moveMirroredConversationOwner,
  readMirroredConversationBuckets,
  readMirroredConversationOwners,
  writeMirroredConversationOwner,
  type MirroredLedgerLogSource
} from './mirrored-conversation-ledger-state'
import { forgetMirroredOwnerSnapshot } from './mirrored-owner-snapshot-persistence'
import { refreshMirroredWorkflowTombstones } from './web-session-workflow-records'

/**
 * The owner can no longer vouch for its rows: `older` when it answered a fresh connection with no
 * ledger (downgraded, or never had one), `unreachable` when the connection its last set came on
 * dropped. Rows stay listed as last known; nothing is removed or acted on. Only a `ready` owner
 * can drop: a restored one was never reached, and an older one stays older (what its rows lack).
 */
export function markOwnerLedgerUnverifiable(
  environmentId: string,
  reason: 'older' | 'unreachable',
  source: MirroredLedgerLogSource = 'runtime-status',
  /** Why an owner reads older, when more than "no ledger" is known (G2 diagnostics). */
  why?: 'owner-without-ledger-capability' | 'owner-ledger-revision-zero'
): void {
  const previous = readMirroredConversationOwners()[environmentId]
  if (previous?.state === reason || (reason === 'unreachable' && previous?.state !== 'ready')) {
    return
  }
  const retained = moveMirroredConversationOwner({
    ...(previous ?? emptyMirroredConversationOwner(environmentId, reason)),
    state: reason
  })
  logMirroredConversationLedger(environmentId, source, {
    decision: 'retained',
    reason: reason === 'older' ? (why ?? 'owner-sends-no-ledger') : 'owner-connection-dropped',
    ...(previous?.generation
      ? { generation: previous.generation, revision: previous.revision }
      : {}),
    retainedRecords: countMirroredConversationRecords(retained)
  })
}

/**
 * The durable snapshot of an owner's ledger, restored at startup (G1): its rows listed `stale` "as
 * of <time>", never retiring anything, and only while nothing live arrived from this owner; the
 * first live set replaces what it covers. An owner already known `older` keeps that state.
 */
export function seedMirroredConversationLedger(
  environmentId: string,
  seed: {
    set: RuntimeSessionConversationLedger
    asOf: number
    asOfByWorktree?: Record<string, number>
    ownerHostId?: string
  }
): boolean {
  if (
    mirroredLedgerOrderByEnvironment.has(environmentId) ||
    readMirroredConversationBuckets(environmentId).length > 0
  ) {
    return false
  }
  const { set } = seed
  const state = readMirroredConversationOwners()[environmentId]?.state ?? 'stale'
  const buckets = Object.entries(set.recordsByWorktree)
    .filter(([, records]) => records.length > 0)
    .map(([worktreeId, records]): MirroredConversationBucket => ({
      environmentId,
      worktreeId,
      records,
      coverage: { complete: false },
      source: set.source,
      generation: set.generation,
      revision: set.revision,
      listedAt: set.listedAt,
      ownerState: mirroredConversationBucketState(state, true),
      asOf: seed.asOfByWorktree?.[worktreeId] ?? seed.asOf,
      stale: true
    }))
  writeMirroredConversationOwner(
    environmentId,
    mirroredConversationOwnerFromSet(environmentId, set, {
      state,
      asOf: seed.asOf,
      ...(seed.ownerHostId ? { ownerHostId: seed.ownerHostId } : {})
    }),
    buckets
  )
  // Why: workflow tombstones the snapshot kept hide those workflows before any live set arrives.
  refreshMirroredWorkflowTombstones(environmentId)
  logMirroredConversationLedger(environmentId, 'durable-snapshot', {
    decision: 'applied',
    reason: 'durable-snapshot-stale',
    generation: set.generation,
    revision: set.revision,
    asOf: seed.asOf,
    records: countMirroredConversationRecords(buckets)
  })
  return true
}

/** The environment left the saved list (never a same-id re-pair): its buckets and entry go. */
export function retractMirroredConversationEnvironment(environmentId: string): void {
  const removed = readMirroredConversationBuckets(environmentId)
  const owner = readMirroredConversationOwners()[environmentId]
  mirroredLedgerOrderByEnvironment.delete(environmentId)
  mirroredLedgerRetiredGenerations.delete(environmentId)
  forgetMirroredOwnerSnapshot(environmentId)
  if (!owner && removed.length === 0) {
    return
  }
  writeMirroredConversationOwner(environmentId, null, [])
  logMirroredConversationLedger(environmentId, 'retraction', {
    decision: 'removed',
    reason: 'environment-removed-from-saved-list',
    ...(owner?.generation ? { generation: owner.generation, revision: owner.revision } : {}),
    removedRecords: countMirroredConversationRecords(removed)
  })
}
