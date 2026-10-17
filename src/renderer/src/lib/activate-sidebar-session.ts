import { isCommandCenterView } from '../../../shared/command-center-navigation'
import { useAppStore } from '@/store'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { activateAndRevealWorkspace } from './worktree-activation'
import { activateTabAndFocusPane } from './activate-tab-and-focus-pane'
import { activateStructuredAgentSessionTab } from './structured-agent-session-tab-activation'
import { gateWorktreeAgentActivation } from './worktree-agent-activation-gate'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'
import { wakeSleptSessionPane } from './wake-slept-session-pane'
import { activateMirroredWorkflow } from './activate-mirrored-workflow'
import { explainMirroredConversationRow } from './activate-mirrored-conversation'

let latestActivation = 0

function findCurrentSession(row: SidebarSession): SidebarSession | undefined {
  return buildSidebarSessions(useAppStore.getState()).find((candidate) =>
    row.sessionKey ? candidate.sessionKey === row.sessionKey : candidate.rowKey === row.rowKey
  )
}

function focusSession(row: SidebarSession): boolean {
  if (!row.tabId) {
    return false
  }
  if (row.kind === 'structured') {
    return activateStructuredAgentSessionTab({ worktreeId: row.worktreeId, tabId: row.tabId })
  }
  const pane = row.paneKey ? parsePaneKey(row.paneKey) : null
  activateTabAndFocusPane(row.tabId, pane?.leafId ?? null, {
    ...(row.paneKey ? { ackPaneKeyOnSuccess: row.paneKey } : {}),
    flashFocusedPane: true,
    scrollToBottomIfOutputSinceLastView: true
  })
  // Why: opening a slept row is its wake — a pane already visible never sees a reveal.
  if (row.paneKey) {
    wakeSleptSessionPane(row.worktreeId, row.paneKey)
  }
  return true
}

// Called only by an explicit session-row click; metadata restore never reaches activation.
export async function activateSidebarSession(
  row: SidebarSession
): Promise<{ handled: 'opened' | 'explained' } | false> {
  const activation = ++latestActivation
  const current = findCurrentSession(row)
  if (!current || current.unavailable || !current.hostId) {
    return false
  }
  // Why: a paired controller's workflow opens there; this window materializes nothing (step 9).
  if (current.mirroredWorkflow) {
    return (await activateMirroredWorkflow(current)) ? { handled: 'opened' } : false
  }
  // Why (session parity, step 7): another computer runs a ledger row's conversation. Only its
  // mirror tab opens here; without one, nothing is swept or created, and the row says where.
  if (current.mirroredConversation && !current.tabId) {
    return explainMirroredConversationRow(current) ? { handled: 'explained' } : false
  }
  if (
    activateAndRevealWorkspace(current.worktreeId, {
      executionHostId: current.hostId,
      providesInitialSurface: true
    }) === false
  ) {
    return false
  }
  const activated = findCurrentSession(current)
  if (activated?.tabId) {
    return focusSession(activated) ? { handled: 'opened' } : false
  }
  if (current.mirroredConversation) {
    return explainMirroredConversationRow(current) ? { handled: 'explained' } : false
  }
  await gateWorktreeAgentActivation(current.worktreeId)
  const state = useAppStore.getState()
  if (
    activation !== latestActivation ||
    state.activeWorktreeId !== current.worktreeId ||
    (state.activeView !== 'terminal' &&
      !(state.settings?.commandCenter
        ? isCommandCenterView(state.activeView)
        : state.activeView === 'attention'))
  ) {
    return false
  }
  const restored = findCurrentSession(current)
  return restored && !restored.unavailable && focusSession(restored) ? { handled: 'opened' } : false
}
