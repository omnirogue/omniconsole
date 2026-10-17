// Pure ordering and evidence decisions for mirrored workflow records (session counts, step 9):
// whether a controller's whole set is newer than what this receiver holds, and what it does to
// that controller's buckets. A thin adapter over mirrored-owner-set-decision.ts: workflow records
// reconcile by their anchor tab and a workflow set's completeness is controller-wide.

import type { MirroredWorkflowBucket } from '@/store/slices/mirrored-workflow-records'
import type {
  RuntimeSessionWorkflowRecord,
  RuntimeSessionWorkflowRecordDelta,
  RuntimeSessionWorkflowRecordSet
} from '../../../shared/session-workflow-records'
import {
  applyMirroredOwnerRecords,
  decideMirroredOwnerDelta,
  decideMirroredOwnerSet,
  type MirroredOwnerDecision,
  type MirroredOwnerIdentity,
  type MirroredOwnerOrder
} from './mirrored-owner-set-decision'

/** The last set (or delta) this receiver accepted from one controller. */
export type MirroredWorkflowOrder = MirroredOwnerOrder

export type MirroredWorkflowSetDecision = MirroredOwnerDecision

const WORKFLOW_IDENTITY: MirroredOwnerIdentity<RuntimeSessionWorkflowRecord> = {
  key: (record) => record.tabId
}

/**
 * The buckets after a message. A workspace the message confirmed (listed records in, or took
 * whole) is live; one it did not keeps its restored `stale`/`asOf` (F24: a snapshot's rows read
 * "as of" until the controller lists them again, never as verified). `unverified` is cleared by
 * any taken message: the controller is sending again.
 */
function toBuckets(
  environmentId: string,
  recordsByWorktree: Map<string, RuntimeSessionWorkflowRecord[]>,
  previous: readonly MirroredWorkflowBucket[],
  confirmed: (worktreeId: string) => boolean
): MirroredWorkflowBucket[] {
  const before = new Map(previous.map((bucket) => [bucket.worktreeId, bucket]))
  return [...recordsByWorktree]
    .filter(([, records]) => records.length > 0)
    .map(([worktreeId, records]) => {
      const kept = confirmed(worktreeId) ? undefined : before.get(worktreeId)
      return {
        environmentId,
        worktreeId,
        records,
        ...(kept?.stale ? { stale: true as const } : {}),
        ...(kept?.stale && kept.asOf !== undefined ? { asOf: kept.asOf } : {})
      }
    })
}

/**
 * Whether to take a controller's set. Within one generation only a higher revision is newer, so a
 * late copy never restores what a newer set removed. A different generation (the controller
 * restarted) is taken only from a fresh connection's initial inventory, which retires the old
 * one; on a running connection it is ignored, as step 3 orders inventory generations.
 */
export function decideMirroredWorkflowSet(args: {
  current: MirroredWorkflowOrder | undefined
  set: RuntimeSessionWorkflowRecordSet | undefined
  /** The set opens a fresh connection (its initial listAll or subscribeAll inventory). */
  fresh: boolean
  retiredGenerations?: ReadonlySet<string>
}): MirroredWorkflowSetDecision {
  // Why this reason: an older controller (or a client it stripped) says nothing about workflows.
  return decideMirroredOwnerSet({ ...args, absentReason: 'no-workflow-evidence' })
}

/**
 * One controller's buckets after taking its set. A complete set is the controller window's whole
 * membership, so whatever it omits is removed; an incomplete one (startup, headless, window
 * closed, malformed) adds and updates but removes nothing.
 */
export function applyMirroredWorkflowSet(
  environmentId: string,
  current: readonly MirroredWorkflowBucket[],
  set: RuntimeSessionWorkflowRecordSet
): { buckets: MirroredWorkflowBucket[]; removedTabIds: string[]; retainedTabIds: string[] } {
  const applied = applyMirroredOwnerRecords({
    current,
    listed: set.recordsByWorktree,
    replacesWhole: () => set.complete,
    scope: 'set',
    identity: WORKFLOW_IDENTITY
  })
  // Why: a complete set speaks for every workspace; an incomplete one only for those it lists in.
  const confirmed = (worktreeId: string): boolean =>
    set.complete || (set.recordsByWorktree[worktreeId]?.length ?? 0) > 0
  return {
    buckets: toBuckets(environmentId, applied.recordsByWorktree, current, confirmed),
    removedTabIds: applied.removed,
    retainedTabIds: applied.retained
  }
}

/**
 * Whether to take a streamed delta: only on top of a complete state of the same generation at
 * least as new as its base, and only when it is newer. Anything else is ignored; the stream's next
 * inventory brings the whole set.
 */
export function decideMirroredWorkflowDelta(args: {
  current: MirroredWorkflowOrder | undefined
  delta: RuntimeSessionWorkflowRecordDelta
  retiredGenerations?: ReadonlySet<string>
}): MirroredWorkflowSetDecision {
  return decideMirroredOwnerDelta({ ...args, requireCompleteBase: true })
}

/** One controller's buckets after a delta: each changed workspace takes its new whole list. */
export function applyMirroredWorkflowDelta(
  environmentId: string,
  current: readonly MirroredWorkflowBucket[],
  delta: RuntimeSessionWorkflowRecordDelta
): { buckets: MirroredWorkflowBucket[]; removedTabIds: string[] } {
  const applied = applyMirroredOwnerRecords({
    current,
    listed: delta.changedByWorktree,
    replacesWhole: () => true,
    scope: 'delta',
    identity: WORKFLOW_IDENTITY
  })
  const confirmed = (worktreeId: string): boolean =>
    Object.hasOwn(delta.changedByWorktree, worktreeId)
  return {
    buckets: toBuckets(environmentId, applied.recordsByWorktree, current, confirmed),
    removedTabIds: applied.removed
  }
}
