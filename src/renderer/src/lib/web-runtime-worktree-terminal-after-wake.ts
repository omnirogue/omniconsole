import { useAppStore } from '@/store'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId
} from '@/runtime/web-runtime-session'
import { getLastKnownHostTerminalTabCount } from '@/runtime/web-session-tabs-sync'
import { beginWebRuntimeAutomaticTerminalCreate } from '@/runtime/web-runtime-automatic-terminal-create'
import { captureWebSessionIntentOwner } from '@/runtime/web-runtime-session-environment'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'

export function ensureWebRuntimeWorktreeTerminalAfterWake(worktreeId: string): void {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    return
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktree.id)
  if (!runtimeEnvironmentId || !isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    return
  }

  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const hasLivePty = tabs.some((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
  if (hasLivePty) {
    return
  }

  const hasMirroredHostTabs = tabs.some((tab) => isWebTerminalSurfaceTabId(tab.id))
  if (hasMirroredHostTabs) {
    // Why: the host session still owns these tabs — wait for the mirror to repopulate PTY handles instead of duplicating a terminal.
    return
  }

  if (getLastKnownHostTerminalTabCount(runtimeEnvironmentId, worktreeId) > 0) {
    return
  }

  const { renderableTabCount } = state.reconcileWorktreeTabModel(worktreeId)
  if (tabs.length > 0 && renderableTabCount === 0) {
    return
  }

  const automaticCreate = beginWebRuntimeAutomaticTerminalCreate(
    captureWebSessionIntentOwner(runtimeEnvironmentId),
    worktreeId
  )
  if (!automaticCreate) {
    return
  }

  // Why: sleep keeps tab rows but terminal.stop clears host PTYs, so a woke workspace can have tab chrome but no surface.
  void createWebRuntimeSessionTerminal({
    worktreeId,
    environmentId: runtimeEnvironmentId,
    clientMutationId: automaticCreate.clientMutationId,
    onSessionCreated: automaticCreate.onSessionCreated,
    activate: true,
    selectWorktree: false
  })
    .then(automaticCreate.finish)
    .catch((error) => {
      automaticCreate.finish({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        creationUnverifiable: true
      })
    })
}
