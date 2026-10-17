// Receiver side of the owner conversation ledger (session parity, step 5). Each paired owner
// publishes its ledger as one value ordered by its own generation and revision — a whole set, then
// per-workspace deltas — and this receiver keeps it as owner-qualified (environment, workspace)
// buckets beside the mirrored terminal rows (never merged across owners, F8), plus one entry per
// owner with its state (G2), catalog and tombstones. Membership outlives generations, reconnects
// and restarts (A5/C1): only a live window set with complete coverage for a workspace, or the
// owner's tombstone (F15), removes a row. Like workflow sets, the ledger carries its own order and
// stays outside the per-workspace frame decisions. Nothing here acts on a conversation.

import { useAppStore } from '@/store'
import type { MirroredConversationOwner } from '@/store/slices/mirrored-conversation-ledger'
import {
  readSessionConversationLedger,
  readSessionConversationLedgerDelta,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationLedgerDelta,
  type RuntimeSessionConversationRemoval
} from '../../../shared/session-conversation-ledger'
import {
  decideMirroredOwnerDelta,
  decideMirroredOwnerSet,
  rememberRetiredGeneration
} from './mirrored-owner-set-decision'
import {
  reconcileMirroredConversationBuckets,
  type MirroredConversationMessage
} from './mirrored-conversation-ledger-reconcile'
import {
  emptyMirroredConversationOwner,
  mirroredConversationDeltaMessage,
  mirroredConversationOwnerFromDelta,
  mirroredConversationOwnerFromSet,
  mirroredConversationSetMessage
} from './mirrored-conversation-ledger-entry'
import {
  MIRRORED_CONVERSATION_DELETION_HISTORY_MS,
  countMirroredConversationRecords,
  logMirroredConversationLedger,
  mirroredLedgerOrderByEnvironment,
  mirroredLedgerRetiredGenerations,
  moveMirroredConversationOwner,
  ownerAdvertisesConversationLedger,
  readMirroredConversationBuckets,
  readMirroredConversationOwners,
  writeMirroredConversationOwner,
  type MirroredLedgerLogSource
} from './mirrored-conversation-ledger-state'
import { markOwnerLedgerUnverifiable } from './mirrored-conversation-ledger-owner'
import { retireMirroredConversationCaptures } from './mirrored-conversation-capture-retirement'
import { rememberMirroredConversationLedger } from './mirrored-owner-snapshot-persistence'
import type { ReceiverFrameSource } from './session-frame-log-receiver'
import { refreshMirroredWorkflowTombstones } from './web-session-workflow-records'

export {
  markOwnerLedgerUnverifiable,
  retractMirroredConversationEnvironment,
  seedMirroredConversationLedger
} from './mirrored-conversation-ledger-owner'
export {
  MIRRORED_CONVERSATION_DELETION_HISTORY_MS,
  resetMirroredConversationLedgerForTests
} from './mirrored-conversation-ledger-state'

function workflowTombstones(removals: readonly RuntimeSessionConversationRemoval[]): string {
  return JSON.stringify(
    removals.flatMap((removal) =>
      removal.workflowTabId ? [[removal.worktreeId, removal.workflowTabId]] : []
    )
  )
}

/** Commits one applied set or delta: buckets, owner entry, workflow tombstones, log, snapshot. */
function commit(
  message: MirroredConversationMessage,
  owner: MirroredConversationOwner,
  context: { reason: string; source: MirroredLedgerLogSource; receivedAt: number; gap: boolean }
): void {
  const { environmentId } = owner
  const previous = readMirroredConversationOwners()[environmentId]
  const result = reconcileMirroredConversationBuckets({
    environmentId,
    current: readMirroredConversationBuckets(environmentId),
    message,
    receivedAt: context.receivedAt,
    ownerState: owner.state,
    deletionHistoryGap: context.gap
  })
  writeMirroredConversationOwner(environmentId, owner, result.buckets)
  const order = { generation: message.generation, revision: message.revision }
  if (workflowTombstones(previous?.removals ?? []) !== workflowTombstones(owner.removals)) {
    const hidden = refreshMirroredWorkflowTombstones(environmentId)
    if (hidden.length > 0) {
      logMirroredConversationLedger(environmentId, context.source, {
        decision: 'removed',
        reason: 'owner-tombstone',
        ...order,
        workflowTabIds: hidden
      })
    }
  }
  logMirroredConversationLedger(environmentId, context.source, {
    decision: 'applied',
    reason: context.reason,
    message: message.kind,
    ...order,
    ledgerSource: message.source,
    records: countMirroredConversationRecords(result.buckets),
    ...(result.retained.length ? { retained: result.retained } : {}),
    ...(result.unverified.length
      ? { unverifiedWorktrees: result.unverified, unverifiedReason: 'deletion-history-gap' }
      : {})
  })
  if (result.omitted.length > 0) {
    logMirroredConversationLedger(environmentId, context.source, {
      decision: 'removed',
      reason: 'owner-window-complete-coverage-omits',
      ...order,
      identities: result.omitted
    })
  }
  if (result.tombstoned.length > 0) {
    logMirroredConversationLedger(environmentId, context.source, {
      decision: 'removed',
      reason: 'owner-tombstone',
      ...order,
      rows: result.tombstoned
    })
  }
  if (result.superseded.length > 0) {
    logMirroredConversationLedger(environmentId, context.source, {
      decision: 'removed',
      reason: 'owner-pane-superseded',
      ...order,
      identities: result.superseded
    })
  }
  // Step 7: this computer's captures follow the owner's decision, whatever their pane id.
  const capturesBefore = useAppStore.getState().sleepingAgentSessionsByPaneKey
  retireMirroredConversationCaptures(environmentId, context.source)
  // Why urgent: a removal here must be on disk before a quit could restore it (C1); a change
  // that removed nothing (a title, a rest) may wait for its burst to settle.
  rememberMirroredConversationLedger(environmentId, {
    urgent:
      result.omitted.length + result.tombstoned.length + result.superseded.length > 0 ||
      useAppStore.getState().sleepingAgentSessionsByPaneKey !== capturesBefore ||
      previous?.removals.length !== owner.removals.length ||
      JSON.stringify(previous?.folders) !== JSON.stringify(owner.folders) ||
      JSON.stringify(previous?.projects) !== JSON.stringify(owner.projects)
  })
}

function applySet(
  environmentId: string,
  set: RuntimeSessionConversationLedger,
  options: { fresh: boolean; source: ReceiverFrameSource },
  receivedAt: number
): void {
  const decision = decideMirroredOwnerSet({
    current: mirroredLedgerOrderByEnvironment.get(environmentId),
    set,
    fresh: options.fresh,
    retiredGenerations: mirroredLedgerRetiredGenerations.get(environmentId)
  })
  const previous = readMirroredConversationOwners()[environmentId]
  if (!decision.apply) {
    const upToDate = decision.reason === 'same-revision' || decision.reason === 'older-revision'
    if (options.fresh && upToDate) {
      // Why: an up-to-date set on a fresh connection is live contact again, after a drop too.
      const owner = previous ?? emptyMirroredConversationOwner(environmentId, 'ready')
      moveMirroredConversationOwner({ ...owner, state: 'ready', asOf: receivedAt }, true)
      retireMirroredConversationCaptures(environmentId, options.source)
      rememberMirroredConversationLedger(environmentId)
    }
    if (decision.reason !== 'same-revision') {
      logMirroredConversationLedger(environmentId, options.source, {
        decision: 'ignored',
        reason: decision.reason,
        generation: set.generation,
        revision: set.revision,
        ledgerSource: set.source
      })
    }
    return
  }
  if (decision.retire) {
    rememberRetiredGeneration(mirroredLedgerRetiredGenerations, environmentId, decision.retire)
  }
  mirroredLedgerOrderByEnvironment.set(environmentId, {
    generation: set.generation,
    revision: set.revision,
    complete: true
  })
  // F15: a cut deletion history, or a reconnect after the owner stopped keeping it, proves nothing.
  const away =
    previous?.asOf != null && receivedAt - previous.asOf > MIRRORED_CONVERSATION_DELETION_HISTORY_MS
  commit(
    mirroredConversationSetMessage(set),
    mirroredConversationOwnerFromSet(environmentId, set, {
      state: 'ready',
      asOf: receivedAt,
      ...(previous?.ownerHostId ? { ownerHostId: previous.ownerHostId } : {})
    }),
    {
      reason: decision.reason,
      source: options.source,
      receivedAt,
      gap: set.removalsTruncated === true || (options.fresh && away)
    }
  )
}

function applyDelta(
  environmentId: string,
  delta: RuntimeSessionConversationLedgerDelta,
  source: ReceiverFrameSource,
  receivedAt: number
): void {
  const decision = decideMirroredOwnerDelta({
    current: mirroredLedgerOrderByEnvironment.get(environmentId),
    delta,
    retiredGenerations: mirroredLedgerRetiredGenerations.get(environmentId),
    requireCompleteBase: false
  })
  if (!decision.apply) {
    if (decision.reason !== 'same-revision') {
      logMirroredConversationLedger(environmentId, source, {
        decision: 'ignored',
        reason: decision.reason,
        generation: delta.generation,
        revision: delta.revision,
        baseRevision: delta.baseRevision
      })
    }
    return
  }
  mirroredLedgerOrderByEnvironment.set(environmentId, {
    generation: delta.generation,
    revision: delta.revision,
    complete: true
  })
  const previous =
    readMirroredConversationOwners()[environmentId] ??
    emptyMirroredConversationOwner(environmentId, 'ready')
  commit(
    mirroredConversationDeltaMessage(delta),
    mirroredConversationOwnerFromDelta(previous, delta, receivedAt),
    { reason: decision.reason, source, receivedAt, gap: delta.removalsTruncated === true }
  )
}

/**
 * An owner's conversation ledger: the whole set (a listAll field, a subscribeAll inventory's
 * field, a `conversationLedger` event) or a streamed delta. `fresh`: it opens a connection (the
 * initial listAll, or any subscribeAll inventory, the one replayed after a reconnect included);
 * only such a set may switch to a new owner generation, and only such an answer without a ledger
 * says the owner is older. An owner that does not name the ledger in its status capabilities is
 * read as answering without one, whatever the field holds (orcad fills it from a store nothing
 * publishes to), and so is a revision-0 set, which no owner has published to yet: its tab frames
 * then keep retiring captures (F9) and its live rows stay verified, as for any older owner.
 */
export function applyMirroredConversationLedger(
  environmentId: string,
  value: unknown,
  options: { fresh: boolean; source: ReceiverFrameSource }
): void {
  const receivedAt = Date.now()
  const advertised = ownerAdvertisesConversationLedger(environmentId)
  const delta = advertised ? readSessionConversationLedgerDelta(value) : null
  if (delta) {
    applyDelta(environmentId, delta, options.source, receivedAt)
    return
  }
  const set = advertised ? readSessionConversationLedger(value) : null
  if (set && set.revision > 0) {
    applySet(environmentId, set, options, receivedAt)
    return
  }
  const why = !advertised
    ? 'owner-without-ledger-capability'
    : set
      ? 'owner-ledger-revision-zero'
      : undefined
  if (options.fresh) {
    markOwnerLedgerUnverifiable(environmentId, 'older', options.source, why)
  } else if (value !== undefined) {
    logMirroredConversationLedger(environmentId, options.source, {
      decision: 'ignored',
      reason: why ?? 'unreadable-ledger'
    })
  }
}
