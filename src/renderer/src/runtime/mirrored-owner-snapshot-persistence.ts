// Durable receiver snapshots (session parity, step 5; G1, G4, C1, F24). After every applied ledger
// set or delta, and every applied workflow set or delta, the window sends what it reconciled for
// that owner to its own main (`runtime:rememberConversationLedger`), which keeps it in
// session-host/ledgers/<environmentId>.json — so a restart never restores pre-deletion state and an
// offline owner's rows come back "as of <time>". One send per owner per task, built from the store
// at send time; nothing is sent for a part this window holds no live evidence of.

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { mirroredConversationBucketsForEnvironment } from '@/store/slices/mirrored-conversation-ledger'
import type { MirroredConversationOwner } from '@/store/slices/mirrored-conversation-ledger'
import type { RememberConversationLedgerRequest } from '../../../shared/remote-conversation-ledger-snapshot'

type WorkflowEvidence = { generation: string; revision: number; asOf: number }

const workflowEvidenceByEnvironment = new Map<string, WorkflowEvidence>()
const liveLedgerEnvironments = new Set<string>()
/** Owners to send this task, and whether the change must land at once (`urgent`). */
const pending = new Map<string, boolean>()
let flushQueued = false

type LedgerPart = Pick<RememberConversationLedgerRequest, 'set' | 'asOf' | 'asOfByWorktree'>

function ledgerPart(state: AppState, owner: MirroredConversationOwner): LedgerPart {
  const buckets = mirroredConversationBucketsForEnvironment(
    state.mirroredConversationLedgerByOwner ?? {},
    owner.environmentId
  )
  const asOf = owner.asOf ?? 0
  const older = buckets.filter((bucket) => bucket.asOf !== asOf)
  return {
    set: {
      generation: owner.generation ?? '',
      revision: owner.revision ?? 0,
      source: owner.source ?? 'main',
      listedAt: owner.listedAt ?? 0,
      // Why incomplete: a remembered listing never stands for an absence (A5).
      coverage: buckets.map(({ worktreeId }) => ({ worktreeId, complete: false })),
      omitted: owner.omitted,
      folders: owner.folders,
      projects: owner.projects,
      recordsByWorktree: Object.fromEntries(
        buckets
          .filter((bucket) => bucket.records.length > 0)
          .map((bucket) => [bucket.worktreeId, bucket.records])
      ),
      removals: owner.removals,
      ...(owner.removalsTruncated ? { removalsTruncated: true as const } : {})
    },
    asOf,
    ...(older.length > 0
      ? {
          asOfByWorktree: Object.fromEntries(
            older.map((bucket) => [bucket.worktreeId, bucket.asOf])
          )
        }
      : {})
  }
}

type WorkflowPart = Pick<
  RememberConversationLedgerRequest,
  'workflowRecords' | 'workflowsAsOf' | 'workflowsAsOfByWorktree'
>

function workflowPart(
  state: AppState,
  environmentId: string,
  evidence: WorkflowEvidence
): WorkflowPart {
  const buckets = Object.values(state.mirroredWorkflowRecordsByOwner ?? {}).filter(
    (bucket) => bucket.environmentId === environmentId
  )
  // Why per workspace: a restored bucket no live set confirmed yet keeps its own older "as of".
  const older = buckets.filter((bucket) => bucket.stale && bucket.asOf !== undefined)
  return {
    workflowRecords: {
      generation: evidence.generation,
      revision: evidence.revision,
      complete: false,
      recordsByWorktree: Object.fromEntries(
        buckets.map((bucket) => [bucket.worktreeId, bucket.records])
      )
    },
    workflowsAsOf: evidence.asOf,
    ...(older.length > 0
      ? {
          workflowsAsOfByWorktree: Object.fromEntries(
            older.map((bucket) => [bucket.worktreeId, bucket.asOf!])
          )
        }
      : {})
  }
}

/** What to keep for one owner now, or null when this window has nothing live to say. */
export function buildMirroredOwnerSnapshotRequest(
  state: AppState,
  environmentId: string
): RememberConversationLedgerRequest | null {
  const owner = state.mirroredConversationOwnersByEnvironment?.[environmentId]
  const ledger =
    liveLedgerEnvironments.has(environmentId) && owner?.generation ? ledgerPart(state, owner) : null
  const workflow = workflowEvidenceByEnvironment.get(environmentId)
  if (!ledger && !workflow) {
    return null
  }
  return {
    environmentId,
    ...(owner?.ownerHostId ? { ownerHostId: owner.ownerHostId } : {}),
    ...ledger,
    ...(workflow ? workflowPart(state, environmentId, workflow) : {})
  }
}

function flush(): void {
  flushQueued = false
  const environments = [...pending]
  pending.clear()
  const send =
    typeof window === 'undefined' ? undefined : window.api?.runtime?.rememberConversationLedger
  const state = typeof useAppStore.getState === 'function' ? useAppStore.getState() : undefined
  if (!send || !state) {
    return
  }
  for (const [environmentId, urgent] of environments) {
    const request = buildMirroredOwnerSnapshotRequest(state, environmentId)
    if (request) {
      // Why ignored: a failed keep only costs the restart view; the owner relists on reconnect.
      void send(urgent ? { ...request, urgent: true } : request).catch(() => {})
    }
  }
}

function schedule(environmentId: string, urgent = false): void {
  pending.set(environmentId, urgent || pending.get(environmentId) === true)
  if (!flushQueued) {
    flushQueued = true
    queueMicrotask(flush)
  }
}

/**
 * The ledger module applied a live set or delta for this owner. `urgent`: it removed rows or
 * captures, added tombstones or changed the catalog, so main writes at once (a quit soon after a
 * deletion must not restore it); anything else may wait for its burst to settle.
 */
export function rememberMirroredConversationLedger(
  environmentId: string,
  options: { urgent?: boolean } = {}
): void {
  liveLedgerEnvironments.add(environmentId)
  schedule(environmentId, options.urgent === true)
}

/** The workflow module applied a live set or delta for this owner. */
export function rememberMirroredWorkflowRecords(
  environmentId: string,
  evidence: WorkflowEvidence
): void {
  workflowEvidenceByEnvironment.set(environmentId, evidence)
  schedule(environmentId)
}

/** The environment left the saved list: stop keeping it (its file stays for a re-pair, G4). */
export function forgetMirroredOwnerSnapshot(environmentId: string): void {
  liveLedgerEnvironments.delete(environmentId)
  workflowEvidenceByEnvironment.delete(environmentId)
  pending.delete(environmentId)
}

export function resetMirroredOwnerSnapshotPersistenceForTests(): void {
  liveLedgerEnvironments.clear()
  workflowEvidenceByEnvironment.clear()
  pending.clear()
}
