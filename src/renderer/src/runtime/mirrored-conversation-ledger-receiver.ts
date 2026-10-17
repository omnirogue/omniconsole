// Startup and connection evidence for paired owners' ledgers on this receiver (session parity,
// step 5). Once the saved-runtime catalog is known, the window reads its own main's durable
// snapshots (`sessionHosts.ledgerSnapshots`) and restores each saved owner's rows `stale` "as of
// <time>", workflow records included (G1, F24); while it runs, an owner whose runtime stops
// answering turns `unreachable`. Neither removes a row: the owner's next live set decides.

import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  readSessionHostsLedgerSnapshotsResult,
  type RemoteConversationLedgerSnapshot
} from '../../../shared/remote-conversation-ledger-snapshot'
import { SESSION_HOSTS_RPC } from '../../../shared/session-hosts-status'
import { callRuntimeRpc } from './runtime-rpc-client'
import {
  markOwnerLedgerUnverifiable,
  seedMirroredConversationLedger
} from './web-session-conversation-ledger'
import { seedMirroredWorkflowRecords } from './web-session-workflow-records'

let loading: Promise<void> | null = null

/**
 * Restores the snapshots of owners still in the saved list; one of a removed environment stays on
 * disk for a later re-pair (G4) and is not shown. Returns the environments restored.
 */
export function restoreMirroredOwnerSnapshots(
  snapshots: readonly RemoteConversationLedgerSnapshot[],
  state: Pick<AppState, 'runtimeEnvironments' | 'removedRuntimeEnvironmentIds'>
): string[] {
  const saved = new Set(state.runtimeEnvironments.map((environment) => environment.id))
  const restored: string[] = []
  for (const snapshot of snapshots) {
    const { environmentId } = snapshot
    if (!saved.has(environmentId) || state.removedRuntimeEnvironmentIds.has(environmentId)) {
      continue
    }
    const ledger = snapshot.set
      ? seedMirroredConversationLedger(environmentId, {
          set: snapshot.set,
          asOf: snapshot.asOf ?? snapshot.savedAt,
          ...(snapshot.asOfByWorktree ? { asOfByWorktree: snapshot.asOfByWorktree } : {}),
          ...(snapshot.ownerHostId ? { ownerHostId: snapshot.ownerHostId } : {})
        })
      : false
    const workflows = snapshot.workflowRecords
      ? seedMirroredWorkflowRecords(
          environmentId,
          snapshot.workflowRecords,
          snapshot.workflowsAsOf ?? snapshot.savedAt,
          snapshot.workflowsAsOfByWorktree
        )
      : false
    if (ledger || workflows) {
      restored.push(environmentId)
    }
  }
  return restored
}

/** Reads and restores the durable snapshots once per window. */
export function loadMirroredOwnerSnapshots(): Promise<void> {
  loading ??= Promise.resolve()
    .then(() => callRuntimeRpc<unknown>({ kind: 'local' }, SESSION_HOSTS_RPC.ledgerSnapshots, {}))
    .then((result) => {
      restoreMirroredOwnerSnapshots(
        readSessionHostsLedgerSnapshotsResult(result).snapshots,
        useAppStore.getState()
      )
    })
    // Why quiet: an older main without the method, or the web client, has no snapshots.
    .catch(() => {})
  return loading
}

/** An owner whose runtime reads unreachable keeps its rows, labelled (G2). */
export function noteMirroredOwnerReachability(
  state: Pick<AppState, 'runtimeStatusByEnvironmentId' | 'mirroredConversationOwnersByEnvironment'>
): void {
  for (const environmentId of Object.keys(state.mirroredConversationOwnersByEnvironment ?? {})) {
    if (state.runtimeStatusByEnvironmentId.get(environmentId)?.status === null) {
      markOwnerLedgerUnverifiable(environmentId, 'unreachable')
    }
  }
}

export function useMirroredConversationLedgerReceiver(): void {
  const catalogHydrated = useAppStore((state) => state.runtimeEnvironmentCatalogHydrated)
  useEffect(() => {
    if (catalogHydrated) {
      void loadMirroredOwnerSnapshots()
    }
  }, [catalogHydrated])
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        if (state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId) {
          noteMirroredOwnerReachability(state)
        }
      }),
    []
  )
}

export function resetMirroredOwnerSnapshotLoadForTests(): void {
  loading = null
}
