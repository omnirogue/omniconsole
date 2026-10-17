import { useAppStore } from '@/store'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { AttentionPane } from './agent-pane-snapshot'

/** Leave the attention view and land on this pane inside its workspace. */
export function openAttentionPaneInWorkspace(
  pane: Pick<AttentionPane, 'worktreeId' | 'tabId' | 'portalPaneKey'>
): boolean {
  const state = useAppStore.getState()
  if (state.activeView === 'attention') {
    state.closeAttentionPage()
  }
  if (useAppStore.getState().activeView !== 'terminal') {
    useAppStore.getState().setActiveView('terminal')
  }
  if (activateAndRevealWorkspace(pane.worktreeId, { providesInitialSurface: true }) === false) {
    return false
  }
  const parsed = pane.portalPaneKey ? parsePaneKey(pane.portalPaneKey) : null
  activateTabAndFocusPane(pane.tabId, parsed?.tabId === pane.tabId ? parsed.leafId : null, {
    flashFocusedPane: true,
    scrollToBottomIfOutputSinceLastView: true
  })
  return true
}

/** Make this pane the "working on" side of the attention view without leaving it. */
export function focusAttentionPaneAsCurrent(
  pane: Pick<AttentionPane, 'worktreeId' | 'tabId' | 'portalPaneKey'>
): boolean {
  if (activateAndRevealWorkspace(pane.worktreeId, { providesInitialSurface: true }) === false) {
    return false
  }
  const parsed = pane.portalPaneKey ? parsePaneKey(pane.portalPaneKey) : null
  activateTabAndFocusPane(pane.tabId, parsed?.tabId === pane.tabId ? parsed.leafId : null, {
    scrollToBottomIfOutputSinceLastView: true
  })
  return true
}
