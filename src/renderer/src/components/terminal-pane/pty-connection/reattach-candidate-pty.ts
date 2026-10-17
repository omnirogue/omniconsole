import type { useAppStore } from '@/store'
import { resolveSshPaneConnectGate } from '../ssh-pane-connect-gate'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

type AppState = ReturnType<typeof useAppStore.getState>

// Why one resolver: the restore flood guard's connect gate asks the provider (pty:hasPty) whether
// the PTY a reattach would name still runs before it lets a held pane connect. When the gate and
// the reattach read different candidates, a split tab's held leaf probed its sibling's live PTY,
// passed as a "live reattach", and was then fresh-spawned with its agent resume in the background.

/** The SSH deferred-connect decision for this pane, as deferred-session-attach.ts acts on it. */
export function resolveSessionSshConnectGate(session: ConnectPanePtySession, state: AppState) {
  const restoredLeafSessionId: string | null =
    session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
      ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
      : null
  const deferredTabSessionId: string | undefined =
    state.deferredSshSessionIdsByTabId?.[session.deps.tabId]
  const tabPtyId = state.tabsByWorktree[session.deps.worktreeId]?.find(
    (t) => t.id === session.deps.tabId
  )?.ptyId
  const gate = resolveSshPaneConnectGate({
    connectionId: session.connectionId,
    sshStatus: state.sshConnectionStates?.get(session.connectionId)?.status,
    isDeferredTarget: state.deferredSshReconnectTargets?.includes(session.connectionId) ?? false,
    restoredLeafSessionId,
    deferredTabSessionId,
    tabPtyId,
    hasLeafSessionMap: Boolean(
      session.deps.restoredPtyIdByLeafId &&
      Object.keys(session.deps.restoredPtyIdByLeafId).length > 0
    )
  })
  return { gate, restoredLeafSessionId, deferredTabSessionId, tabPtyId }
}

/** The PTY ids the local reattach choice reads (deferred-session-reattach-choice.ts). */
export function resolveLocalReattachCandidates(
  session: ConnectPanePtySession,
  state: AppState
) {
  const restoredPtyId: string | null =
    session.deps.restoredLeafId && session.deps.restoredPtyIdByLeafId
      ? (session.deps.restoredPtyIdByLeafId[session.deps.restoredLeafId] ?? null)
      : null
  const existingPtyId = state.tabsByWorktree[session.deps.worktreeId]?.find(
    (t) => t.id === session.deps.tabId
  )?.ptyId
  // Why: the tab-level fallback must not steal a PTY a setup sibling already published while the
  // main pane waited for split geometry.
  const tabFallbackPtyId =
    existingPtyId &&
    !Array.from(session.deps.paneTransportsRef.current.entries()).some(
      ([candidatePaneId, candidateTransport]) =>
        candidatePaneId !== session.pane.id && candidateTransport.getPtyId() === existingPtyId
    )
      ? existingPtyId
      : null
  // Why: a leaf binding always names this pane's PTY; the tab-level PTY is this pane's only when
  // no other pane transport existed when it connected and no sibling owns it.
  const candidatePtyId: string | null =
    restoredPtyId ||
    (tabFallbackPtyId && !session.hadExistingPaneTransportAtConnect ? tabFallbackPtyId : null)
  return { restoredPtyId, existingPtyId, tabFallbackPtyId, candidatePtyId }
}

/** The PTY a connect of this pane would reattach right now; null when it would spawn. */
export function resolvePaneReattachPtyId(
  session: ConnectPanePtySession,
  state: AppState
): string | null {
  if (session.connectionId) {
    const { gate } = resolveSessionSshConnectGate(session, state)
    if (gate.enterDeferredFlow) {
      return gate.pendingSessionId
    }
  }
  return resolveLocalReattachCandidates(session, state).candidatePtyId
}
