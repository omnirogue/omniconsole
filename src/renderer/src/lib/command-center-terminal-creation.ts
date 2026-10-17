import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useSessionGrid } from '@/store/session-grid'
import { tryTerminalCreationRoute } from '@/store/terminals/terminal-workspace-routing'
import { sidebarSessionWorkspace } from './sidebar-session-context'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import {
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'

export class TerminalCreationUnverifiableError extends Error {}

/** Called only by the empty pane's explicit create button. */
export async function createCommandCenterTerminal(
  paneId: string,
  worktreeId: string
): Promise<void> {
  const state = useAppStore.getState()
  if (state.settings?.commandCenter !== true) {
    return
  }
  const route = tryTerminalCreationRoute(state, worktreeId)
  if (!route) {
    throw new Error('The execution host is unresolved or disconnected. No terminal was created.')
  }
  const owner = sidebarSessionWorkspace(state, worktreeId)
  if (!owner.hostId || owner.unavailable) {
    throw new Error('The execution host is unverifiable. No terminal was created.')
  }
  const attach = (tabId: string): void => {
    const pane = useSessionGrid.getState().panes[paneId]
    if (pane?.kind === 'view' && pane.viewId === 'terminal') {
      useSessionGrid.getState().replacePane(paneId, {
        kind: 'session',
        worktreeId,
        tabId,
        paneKey: null,
        sessionKey: JSON.stringify([owner.hostId, worktreeId, tabId]),
        executionHostId: owner.hostId,
        label: translate('commandCenter.content.terminal', 'Terminal')
      })
    }
    requestBackgroundTerminalWorktreeMount({ worktreeId, tabIds: [tabId] })
  }
  if (route.runtimeEnvironmentId) {
    if (!isWebRuntimeSessionActive(route.runtimeEnvironmentId)) {
      throw new Error('The execution computer is disconnected. No terminal was created.')
    }
    const result = await createWebRuntimeSessionTerminal({
      worktreeId,
      environmentId: route.runtimeEnvironmentId,
      activate: false,
      selectWorktree: false,
      onSessionCreated: attach
    })
    if (result.status === 'failed') {
      if (result.creationUnverifiable) {
        throw new TerminalCreationUnverifiableError(result.message)
      }
      throw new Error(result.message)
    }
    return
  }
  attach(state.createTab(worktreeId, undefined, undefined, { activate: false }).id)
}
