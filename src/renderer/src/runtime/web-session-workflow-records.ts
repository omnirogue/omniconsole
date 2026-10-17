// Receiver side of controller-owned workflow records (session counts, step 9). Each paired
// controller publishes its whole workflow set as one value ordered by its own generation and
// revision; this receiver keeps the newest one per controller, as owner-qualified
// (environment, workspace) buckets beside the mirrored terminal rows. A workflow belongs to the
// window that runs it, so its removal is judged from the controller's complete set alone: no
// terminal frame, process census or workspace omission removes one, and an incomplete set
// (startup, headless, window closed) removes nothing. The one other evidence is the owner's own
// delete (session parity F24): a `workflowTabId` tombstone in its conversation ledger hides that
// record for as long as the owner keeps the tombstone, whatever the workflow sets still list.
//
// Why outside the per-workspace frame decisions: step 3's inventory ordering (inventoryOrder) and
// its delayed-removal rejection gate terminal frames; workflow sets carry their own order and
// never pass through that gate, so neither has to run before the other.

import { useAppStore } from '@/store'
import {
  mirroredWorkflowBucketKey,
  type MirroredWorkflowBucket
} from '@/store/slices/mirrored-workflow-records'
import {
  readSessionWorkflowRecordDelta,
  readSessionWorkflowRecordSet,
  type RuntimeSessionWorkflowRecordDelta,
  type RuntimeSessionWorkflowRecordSet
} from '../../../shared/session-workflow-records'
import { isSessionFrameLogEnabled, recordSessionFrameLog } from './session-frame-log'
import type { ReceiverFrameSource } from './session-frame-log-receiver'
import {
  applyMirroredWorkflowDelta,
  applyMirroredWorkflowSet,
  decideMirroredWorkflowDelta,
  decideMirroredWorkflowSet,
  type MirroredWorkflowOrder
} from './mirrored-workflow-block-decision'
import { rememberRetiredGeneration } from './mirrored-owner-set-decision'
import { rememberMirroredWorkflowRecords } from './mirrored-owner-snapshot-persistence'

const orderByEnvironment = new Map<string, MirroredWorkflowOrder>()
/** Generations a controller has moved past, per environment: their delayed sets are fenced. */
const retiredGenerationsByEnvironment = new Map<string, Set<string>>()
/** What each controller lists, before its owner's tombstones hide anything (F24). */
const listedBucketsByEnvironment = new Map<string, MirroredWorkflowBucket[]>()

function readBuckets(): Record<string, MirroredWorkflowBucket> {
  return typeof useAppStore.getState === 'function'
    ? (useAppStore.getState()?.mirroredWorkflowRecordsByOwner ?? {})
    : {}
}

/** `[worktreeId, tabId]` keys the owner's ledger tombstones name (session parity F24). */
function tombstonedWorkflowKeys(environmentId: string): Set<string> {
  const owner =
    typeof useAppStore.getState === 'function'
      ? useAppStore.getState()?.mirroredConversationOwnersByEnvironment?.[environmentId]
      : undefined
  return new Set(
    (owner?.removals ?? []).flatMap((removal) =>
      removal.workflowTabId ? [JSON.stringify([removal.worktreeId, removal.workflowTabId])] : []
    )
  )
}

/** Writes what the controller lists minus what its owner deleted; returns the hidden tab ids. */
function replaceEnvironmentBuckets(
  environmentId: string,
  buckets: readonly MirroredWorkflowBucket[]
): string[] {
  listedBucketsByEnvironment.set(environmentId, [...buckets])
  const tombstoned = tombstonedWorkflowKeys(environmentId)
  const hidden: string[] = []
  const shown = buckets.flatMap((bucket): MirroredWorkflowBucket[] => {
    const records = bucket.records.filter((record) => {
      const deleted = tombstoned.has(JSON.stringify([bucket.worktreeId, record.tabId]))
      if (deleted) {
        hidden.push(record.tabId)
      }
      return !deleted
    })
    if (records.length === bucket.records.length) {
      return [bucket]
    }
    return records.length > 0 ? [{ ...bucket, records }] : []
  })
  if (typeof useAppStore.setState !== 'function') {
    return hidden
  }
  useAppStore.setState((state) => {
    const next: Record<string, MirroredWorkflowBucket> = {}
    for (const [key, bucket] of Object.entries(state.mirroredWorkflowRecordsByOwner ?? {})) {
      if (bucket.environmentId !== environmentId) {
        next[key] = bucket
      }
    }
    for (const bucket of shown) {
      next[mirroredWorkflowBucketKey(environmentId, bucket.worktreeId)] = bucket
    }
    return { mirroredWorkflowRecordsByOwner: next }
  })
  return hidden
}

function environmentBuckets(environmentId: string): MirroredWorkflowBucket[] {
  return (
    listedBucketsByEnvironment.get(environmentId) ??
    Object.values(readBuckets()).filter((bucket) => bucket.environmentId === environmentId)
  )
}

function logWorkflow(
  environmentId: string,
  source: ReceiverFrameSource,
  fields: Record<string, unknown>
): void {
  if (isSessionFrameLogEnabled()) {
    recordSessionFrameLog({ kind: 'receiver.workflow', environmentId, source, ...fields })
  }
}

/** Keeps this controller's newest records durably (session parity F24). */
function remember(environmentId: string, order: { generation: string; revision: number }): void {
  rememberMirroredWorkflowRecords(environmentId, {
    generation: order.generation,
    revision: order.revision,
    asOf: Date.now()
  })
}

/**
 * A controller that sent sets now answers a fresh connection with none (it was downgraded, or
 * lost the capability): its last rows stay listed but say they can't be verified.
 */
function markControllerUnverifiable(environmentId: string, source: ReceiverFrameSource): void {
  const buckets = environmentBuckets(environmentId)
  if (buckets.every((bucket) => bucket.unverified)) {
    return
  }
  replaceEnvironmentBuckets(
    environmentId,
    buckets.map((bucket) => ({ ...bucket, unverified: true as const }))
  )
  logWorkflow(environmentId, source, {
    decision: 'retained',
    reason: 'controller-stopped-sending-workflow-records',
    retainedTabIds: buckets.flatMap((bucket) => bucket.records.map((record) => record.tabId))
  })
}

function applyDelta(
  environmentId: string,
  delta: RuntimeSessionWorkflowRecordDelta,
  source: ReceiverFrameSource
): void {
  const decision = decideMirroredWorkflowDelta({
    current: orderByEnvironment.get(environmentId),
    delta,
    retiredGenerations: retiredGenerationsByEnvironment.get(environmentId)
  })
  const order = { generation: delta.generation, revision: delta.revision }
  if (!decision.apply) {
    if (decision.reason !== 'same-revision') {
      logWorkflow(environmentId, source, { decision: 'ignored', reason: decision.reason, order })
    }
    return
  }
  orderByEnvironment.set(environmentId, { ...order, complete: true })
  const applied = applyMirroredWorkflowDelta(
    environmentId,
    environmentBuckets(environmentId),
    delta
  )
  const hidden = replaceEnvironmentBuckets(environmentId, applied.buckets)
  logWorkflow(environmentId, source, {
    decision: 'applied',
    reason: decision.reason,
    order,
    changedWorktrees: Object.keys(delta.changedByWorktree),
    ...(applied.removedTabIds.length ? { removedTabIds: applied.removedTabIds } : {}),
    ...(hidden.length ? { tombstonedTabIds: hidden } : {})
  })
  remember(environmentId, order)
}

/**
 * A controller's workflow records: the whole set (a listAll field, a subscribeAll inventory's
 * field, a `workflowRecords` event) or a streamed delta. `fresh`: it opens a connection (the
 * initial listAll, or any subscribeAll inventory, including the one replayed after a reconnect);
 * only such a set may switch to a new controller generation.
 */
export function applyMirroredWorkflowRecords(
  environmentId: string,
  value: unknown,
  options: { fresh: boolean; source: ReceiverFrameSource }
): void {
  const delta = readSessionWorkflowRecordDelta(value)
  if (delta) {
    applyDelta(environmentId, delta, options.source)
    return
  }
  const set = readSessionWorkflowRecordSet(value)
  if (!set && options.fresh && orderByEnvironment.has(environmentId)) {
    markControllerUnverifiable(environmentId, options.source)
    return
  }
  const decision = decideMirroredWorkflowSet({
    current: orderByEnvironment.get(environmentId),
    set,
    fresh: options.fresh,
    retiredGenerations: retiredGenerationsByEnvironment.get(environmentId)
  })
  if (!decision.apply || !set) {
    if (set && decision.reason !== 'same-revision') {
      logWorkflow(environmentId, options.source, {
        decision: 'ignored',
        reason: decision.reason,
        set: { generation: set.generation, revision: set.revision, complete: set.complete }
      })
    }
    return
  }
  if (decision.retire) {
    rememberRetiredGeneration(retiredGenerationsByEnvironment, environmentId, decision.retire)
  }
  orderByEnvironment.set(environmentId, {
    generation: set.generation,
    revision: set.revision,
    complete: set.complete
  })
  const applied = applyMirroredWorkflowSet(environmentId, environmentBuckets(environmentId), set)
  const hidden = replaceEnvironmentBuckets(environmentId, applied.buckets)
  logWorkflow(environmentId, options.source, {
    decision: 'applied',
    reason: set.complete ? decision.reason : `${decision.reason}:incomplete-retains-omissions`,
    set: { generation: set.generation, revision: set.revision, complete: set.complete },
    mirroredCount: applied.buckets.reduce((total, bucket) => total + bucket.records.length, 0),
    ...(applied.removedTabIds.length ? { removedTabIds: applied.removedTabIds } : {}),
    ...(applied.retainedTabIds.length ? { retainedTabIds: applied.retainedTabIds } : {}),
    ...(hidden.length ? { tombstonedTabIds: hidden } : {})
  })
  remember(environmentId, set)
}

/**
 * The owner's ledger tombstones changed (session parity F24): rewrite what this controller's
 * workflows show from what it lists, hiding every record the owner deleted and showing again one
 * whose tombstone it withdrew (an undo). Returns the tab ids hidden now.
 */
export function refreshMirroredWorkflowTombstones(environmentId: string): string[] {
  const listed = listedBucketsByEnvironment.get(environmentId)
  return listed ? replaceEnvironmentBuckets(environmentId, listed) : []
}

/**
 * The durable snapshot of a controller's workflows, restored at startup (F24): listed stale "as
 * of <time>", never retiring anything, and only while nothing live arrived for this controller.
 */
export function seedMirroredWorkflowRecords(
  environmentId: string,
  set: RuntimeSessionWorkflowRecordSet,
  asOf: number,
  /** Workspaces last confirmed live before `asOf` (kept "as of" through later incomplete sets). */
  asOfByWorktree?: Record<string, number>
): boolean {
  if (orderByEnvironment.has(environmentId) || environmentBuckets(environmentId).length > 0) {
    return false
  }
  replaceEnvironmentBuckets(
    environmentId,
    Object.entries(set.recordsByWorktree)
      .filter(([, records]) => records.length > 0)
      .map(([worktreeId, records]) => ({
        environmentId,
        worktreeId,
        records,
        stale: true as const,
        asOf: asOfByWorktree?.[worktreeId] ?? asOf
      }))
  )
  return true
}

/** The environment left the saved list (never a same-id re-pair): all its records go. */
export function retractMirroredWorkflowEnvironment(environmentId: string): void {
  const removed = Object.values(readBuckets()).filter(
    (bucket) => bucket.environmentId === environmentId
  )
  orderByEnvironment.delete(environmentId)
  retiredGenerationsByEnvironment.delete(environmentId)
  if (removed.length > 0) {
    replaceEnvironmentBuckets(environmentId, [])
  }
  listedBucketsByEnvironment.delete(environmentId)
  if (removed.length > 0 && isSessionFrameLogEnabled()) {
    recordSessionFrameLog({
      kind: 'receiver.workflow',
      environmentId,
      source: 'retraction',
      decision: 'removal',
      reason: 'environment-removed-from-saved-list',
      removedTabIds: removed.flatMap((bucket) => bucket.records.map((record) => record.tabId))
    })
  }
}

export function resetMirroredWorkflowRecordsForTests(): void {
  orderByEnvironment.clear()
  retiredGenerationsByEnvironment.clear()
  listedBucketsByEnvironment.clear()
}
