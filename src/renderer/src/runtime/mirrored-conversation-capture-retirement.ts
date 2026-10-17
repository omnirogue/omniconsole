// The ledger half of capture retirement (session parity, step 7): once a set or delta from a
// reachable owner is applied, this computer's captures of that owner's conversations go when the
// owner's live window lists their workspace completely and names them nowhere (not even as
// passive `listed: false` evidence, G1), or when its tombstone names them (F15). The frame half is
// mirrored-conversation-frame-captures.ts. Retraction drops only this computer's copies, through
// the record-only retraction a person's delete uses, so it is logged and returns its undo.

import { useAppStore } from '@/store'
import {
  mirroredConversationBucketKey,
  mirroredConversationBucketsForEnvironment
} from '@/store/slices/mirrored-conversation-ledger'
import { getCatalogRuntimeOwnerEnvironmentId } from '@/lib/session-inventory-workspace-provenance'
import { retractRecordOnlyMirrorRows } from '@/lib/record-only-mirror-row-retraction'
import { findOwnerOmittedConversationRecordPaneKeys } from './web-session-mirror-sleeping-records'
import {
  logMirroredConversationLedger,
  type MirroredLedgerLogSource
} from './mirrored-conversation-ledger-state'

const NO_UNDO = (): void => {}

/**
 * Retires the captures `environmentId`'s ledger no longer vouches for, in one write. Returns the
 * undo, which puts back the records (and launch configs) it dropped; nothing happens unless the
 * owner is reachable live (a restored snapshot or an unreachable owner retires nothing).
 */
export function retireMirroredConversationCaptures(
  environmentId: string,
  source: MirroredLedgerLogSource
): () => void {
  if (typeof useAppStore.getState !== 'function') {
    return NO_UNDO
  }
  const state = useAppStore.getState()
  const owner = state.mirroredConversationOwnersByEnvironment?.[environmentId]
  if (!owner || owner.state !== 'ready') {
    return NO_UNDO
  }
  const buckets = state.mirroredConversationLedgerByOwner ?? {}
  const worktreeIds = new Set([
    ...mirroredConversationBucketsForEnvironment(buckets, environmentId).map((b) => b.worktreeId),
    ...owner.removals.map((removal) => removal.worktreeId)
  ])
  const omitted: string[] = []
  const tombstoned: string[] = []
  for (const worktreeId of worktreeIds) {
    const found = findOwnerOmittedConversationRecordPaneKeys(
      state.sleepingAgentSessionsByPaneKey,
      buckets[mirroredConversationBucketKey(environmentId, worktreeId)],
      {
        environmentId,
        worktreeId,
        catalogOwnerEnvironmentId: getCatalogRuntimeOwnerEnvironmentId(state, worktreeId),
        keptTabIds: new Set((state.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)),
        removals: owner.removals
      }
    )
    omitted.push(...found.omitted)
    tombstoned.push(...found.tombstoned)
  }
  if (omitted.length + tombstoned.length === 0) {
    return NO_UNDO
  }
  const before = state.sleepingAgentSessionsByPaneKey ?? {}
  const restore = retractRecordOnlyMirrorRows([...omitted, ...tombstoned])
  const after = useAppStore.getState().sleepingAgentSessionsByPaneKey ?? {}
  const gone = (paneKey: string): boolean => Boolean(before[paneKey]) && !after[paneKey]
  if (omitted.some(gone) || tombstoned.some(gone)) {
    logMirroredConversationLedger(environmentId, source, {
      decision: 'retract-capture',
      generation: owner.generation,
      revision: owner.revision,
      ...(omitted.some(gone) ? { omitted: omitted.filter(gone) } : {}),
      ...(tombstoned.some(gone) ? { tombstoned: tombstoned.filter(gone) } : {})
    })
  }
  return restore
}
