// The receiver's in-memory ordering of paired owners' conversation ledgers and its one write path
// into the ledger slice (session parity, step 5), shared by the apply path
// (web-session-conversation-ledger.ts) and the owner transitions
// (mirrored-conversation-ledger-owner.ts).

import { useAppStore } from '@/store'
import {
  mirroredConversationBucketKey,
  mirroredConversationBucketState,
  mirroredConversationBucketsForEnvironment,
  type MirroredConversationBucket,
  type MirroredConversationOwner
} from '@/store/slices/mirrored-conversation-ledger'
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { MirroredOwnerOrder } from './mirrored-owner-set-decision'
import { resetMirroredOwnerSnapshotPersistenceForTests } from './mirrored-owner-snapshot-persistence'
import { isSessionFrameLogEnabled, recordSessionFrameLog } from './session-frame-log'
import type { ReceiverFrameSource } from './session-frame-log-receiver'

/** How long an owner keeps tombstones (main's CONVERSATION_REMOVAL_RETENTION_MS, addendum F4). */
export const MIRRORED_CONVERSATION_DELETION_HISTORY_MS = 90 * 24 * 60 * 60 * 1000

export type MirroredLedgerLogSource =
  | ReceiverFrameSource
  | 'retraction'
  | 'runtime-status'
  | 'durable-snapshot'

/** The last set or delta taken from each owner; a restored snapshot sets none. */
export const mirroredLedgerOrderByEnvironment = new Map<string, MirroredOwnerOrder>()
/** Generations an owner moved past, per environment: their delayed sets are fenced. */
export const mirroredLedgerRetiredGenerations = new Map<string, Set<string>>()

export function readMirroredConversationOwners(): Record<string, MirroredConversationOwner> {
  return typeof useAppStore.getState === 'function'
    ? (useAppStore.getState()?.mirroredConversationOwnersByEnvironment ?? {})
    : {}
}

/**
 * Whether the owner names the ledger in its runtime status. A runtime advertises
 * `session-tabs.conversation-ledger.v1` only while its owner ledger publisher runs
 * (session-conversation-ledger-runtime.ts): a desktop owner, never orcad — which still answers a
 * negotiated client with an empty revision-0 set from a store nothing publishes to. Why read
 * here: the field's presence on the wire proves nothing about who fills it.
 */
export function ownerAdvertisesConversationLedger(environmentId: string): boolean {
  const status =
    typeof useAppStore.getState === 'function'
      ? useAppStore.getState()?.runtimeStatusByEnvironmentId?.get(environmentId)?.status
      : undefined
  return (
    status?.capabilities?.includes(SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY) === true
  )
}

export function readMirroredConversationBuckets(
  environmentId: string
): MirroredConversationBucket[] {
  return typeof useAppStore.getState === 'function'
    ? mirroredConversationBucketsForEnvironment(
        useAppStore.getState()?.mirroredConversationLedgerByOwner ?? {},
        environmentId
      )
    : []
}

/** Replaces one owner's entry and buckets in one write; a null owner removes both. */
export function writeMirroredConversationOwner(
  environmentId: string,
  owner: MirroredConversationOwner | null,
  buckets: readonly MirroredConversationBucket[]
): void {
  if (typeof useAppStore.setState !== 'function') {
    return
  }
  useAppStore.setState((state) => {
    const nextBuckets: Record<string, MirroredConversationBucket> = {}
    for (const [key, bucket] of Object.entries(state.mirroredConversationLedgerByOwner ?? {})) {
      if (bucket.environmentId !== environmentId) {
        nextBuckets[key] = bucket
      }
    }
    for (const bucket of buckets) {
      nextBuckets[mirroredConversationBucketKey(environmentId, bucket.worktreeId)] = bucket
    }
    const owners = { ...state.mirroredConversationOwnersByEnvironment }
    if (owner) {
      owners[environmentId] = owner
    } else {
      delete owners[environmentId]
    }
    return {
      mirroredConversationLedgerByOwner: nextBuckets,
      mirroredConversationOwnersByEnvironment: owners
    }
  })
}

/**
 * The owner entry becomes `next`; its buckets follow its state with their rows untouched. With
 * `refreshAsOf`, live buckets are confirmed as of `next.asOf` (restored rows never are).
 */
export function moveMirroredConversationOwner(
  next: MirroredConversationOwner,
  refreshAsOf = false
): MirroredConversationBucket[] {
  const buckets = readMirroredConversationBuckets(next.environmentId).map((bucket) => ({
    ...bucket,
    ...(refreshAsOf && !bucket.stale && next.asOf !== null ? { asOf: next.asOf } : {}),
    ownerState: mirroredConversationBucketState(next.state, Boolean(bucket.stale))
  }))
  writeMirroredConversationOwner(next.environmentId, next, buckets)
  return buckets
}

export function countMirroredConversationRecords(
  buckets: readonly MirroredConversationBucket[]
): number {
  return buckets.reduce((total, bucket) => total + bucket.records.length, 0)
}

export function logMirroredConversationLedger(
  environmentId: string,
  source: MirroredLedgerLogSource,
  fields: Record<string, unknown>
): void {
  if (isSessionFrameLogEnabled()) {
    recordSessionFrameLog({ kind: 'receiver.ledger', environmentId, source, ...fields })
  }
}

export function resetMirroredConversationLedgerForTests(): void {
  mirroredLedgerOrderByEnvironment.clear()
  mirroredLedgerRetiredGenerations.clear()
  resetMirroredOwnerSnapshotPersistenceForTests()
}
