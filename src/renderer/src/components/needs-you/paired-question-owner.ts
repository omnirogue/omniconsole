import type { AppState } from '@/store/types'
import { getReachableRuntimeSessionMirrorTargets } from '@/lib/runtime-session-mirror-targets'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { pendingSessionAsk } from '../../../../shared/session-questions'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  isCanonicalWebTerminalSurfaceTabId,
  isWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'

/** Capture the displayed source before asking its owner; a reconnect invalidates it. */
export function capturePairedQuestionOwner(state: Partial<AppState>, paneKey: string) {
  const entry = state.agentStatusByPaneKey?.[paneKey]
  const pane = parsePaneKey(paneKey)
  if (
    !entry ||
    !pane ||
    !entry.worktreeId ||
    !entry.providerSession?.id ||
    !entry.agentType ||
    !entry.interactivePrompt ||
    !pendingSessionAsk(entry) ||
    entry.connectionId ||
    entry.restoredUnconfirmed ||
    state.runtimeEnvironmentCatalogHydrated !== true
  ) {
    return null
  }
  const ptyId = state.terminalLayoutsByTabId?.[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  const pty = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  if (!pty?.environmentId || !pty.handle || entry.terminalHandle !== pty.handle) {
    return null
  }
  const owner = getReachableRuntimeSessionMirrorTargets(state).find(
    (target) => target.environmentId === pty.environmentId
  )
  if (!owner || getRuntimeEnvironmentRevision(owner.environmentId) !== owner.pairingRevision) {
    return null
  }
  const tabs = state.unifiedTabsByWorktree?.[entry.worktreeId]?.filter(
    (tab) => tab.id === pane.tabId
  )
  const tab = tabs?.length === 1 ? tabs[0] : undefined
  const hostTabId = toHostSessionTabId(pane.tabId)
  if (
    !tab ||
    tab.contentType !== 'terminal' ||
    tab.worktreeId !== entry.worktreeId ||
    tab.executionHostId !== toRuntimeExecutionHostId(owner.environmentId) ||
    (entry.tabId !== undefined && entry.tabId !== tab.id) ||
    !isWebTerminalSurfaceTabId(tab.id) ||
    !isCanonicalWebTerminalSurfaceTabId(tab.id, hostTabId, owner.environmentId)
  ) {
    return null
  }
  return {
    ...owner,
    target: {
      worktreeId: entry.worktreeId,
      paneKey: makePaneKey(hostTabId, pane.leafId),
      terminal: pty.handle
    },
    displayed: {
      interactivePrompt: entry.interactivePrompt,
      stateStartedAt: entry.stateStartedAt,
      agentType: entry.agentType,
      providerSession: { key: entry.providerSession.key, id: entry.providerSession.id }
    },
    sourceFingerprint: JSON.stringify([
      entry.agentType,
      entry.state,
      entry.workingMode,
      entry.toolName,
      entry.promptInteractionKey,
      entry.observation,
      ptyId,
      tab.entityId
    ])
  }
}

export type PairedQuestionOwner = NonNullable<ReturnType<typeof capturePairedQuestionOwner>>

export function isPairedQuestionOwnerCurrent(
  state: Partial<AppState>,
  paneKey: string,
  owner: PairedQuestionOwner
): boolean {
  return JSON.stringify(capturePairedQuestionOwner(state, paneKey)) === JSON.stringify(owner)
}
