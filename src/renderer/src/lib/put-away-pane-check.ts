import {
  buildPaneSessions,
  type SidebarSession,
  type SidebarSessionSource
} from './sidebar-sessions'
import { conversationViewKey, isPersonalRowHidden } from './conversation-view'
import type { SessionSidebarView } from './session-sidebar-view'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import type { WorktreeOperationRouteState } from './worktree-operation-route'

/** Everything buildPaneSessions reads, including the owner catalogs its host lookup walks. */
export type PaneSessionInputs = SidebarSessionSource &
  WorktreeRuntimeOwnerState &
  WorktreeOperationRouteState

// Why a Record: a slice added to any of these types fails to compile here until it also
// invalidates the cached rows below; a missed slice would answer "put away" from stale rows.
const PANE_SESSION_INPUT_SLICES: Record<keyof PaneSessionInputs, true> = {
  repos: true,
  worktreesByRepo: true,
  detectedWorktreesByRepo: true,
  folderWorkspaces: true,
  projectGroups: true,
  sshConnectionStates: true,
  runtimeStatusByEnvironmentId: true,
  restoredRuntimeHostIdByWorkspaceSessionKey: true,
  activeWorktreeId: true,
  activeWorkspaceExecutionHostId: true,
  settings: true,
  runtimeEnvironments: true,
  runtimeEnvironmentCatalogHydrated: true,
  removedRuntimeEnvironmentIds: true,
  tabsByWorktree: true,
  unifiedTabsByWorktree: true,
  terminalLayoutsByTabId: true,
  agentStatusByPaneKey: true,
  sleepingAgentSessionsByPaneKey: true,
  pendingStartupByTabId: true,
  automaticAgentResumeClaimsByTabId: true,
  localWorkflowStatusByTabId: true,
  localWorkflowHydrationByTabId: true,
  buildReview: true,
  mirroredWorkflowRecordsByOwner: true,
  mirroredConversationLedgerByOwner: true,
  mirroredConversationOwnersByEnvironment: true,
  ptyIdsByTabId: true
}
const PANE_SESSION_INPUT_KEYS = Object.keys(
  PANE_SESSION_INPUT_SLICES
) as (keyof PaneSessionInputs)[]

/** Whether any slice a pane row is built from changed between two store states. */
export function paneSessionInputsChanged(
  state: PaneSessionInputs,
  prev: PaneSessionInputs
): boolean {
  return PANE_SESSION_INPUT_KEYS.some((key) => state[key] !== prev[key])
}

/** Archived, hidden or deleted, keyed as the sidebar keys the row (`conversationViewKey`). */
export function isPutAwayRow(
  session: SidebarSession | undefined,
  view: SessionSidebarView,
  archived: readonly string[]
): boolean {
  if (!session) {
    return false
  }
  const key = conversationViewKey(session)
  return (
    archived.includes(key) ||
    (view.archived?.includes(key) ?? false) ||
    (view.deleted?.includes(key) ?? false) ||
    isPersonalRowHidden(view, session)
  )
}

export type PutAwayPaneCheck = (
  paneKey: string,
  state: PaneSessionInputs,
  view: SessionSidebarView,
  archived: readonly string[]
) => boolean

/**
 * The put-away check with its cost paid once: pane rows are rebuilt only when a slice they are
 * built from changed, and each pane's verdict is kept until those rows or the personal view
 * (its `view`/`archived` revision) change. Answers exactly what a fresh rebuild would.
 */
export function createPutAwayPaneCheck(): PutAwayPaneCheck {
  let builtFrom: PaneSessionInputs | null = null
  let rowsByPaneKey = new Map<string, SidebarSession>()
  let decidedView: SessionSidebarView | null = null
  let decidedArchived: readonly string[] | null = null
  const decisions = new Map<string, boolean>()
  return (paneKey, state, view, archived) => {
    if (!builtFrom || paneSessionInputsChanged(state, builtFrom)) {
      rowsByPaneKey = new Map()
      for (const row of buildPaneSessions(state)) {
        // Why first wins: the uncached check took the first row with this pane key.
        if (row.paneKey && !rowsByPaneKey.has(row.paneKey)) {
          rowsByPaneKey.set(row.paneKey, row)
        }
      }
      builtFrom = state
      decisions.clear()
    }
    if (decidedView !== view || decidedArchived !== archived) {
      decidedView = view
      decidedArchived = archived
      decisions.clear()
    }
    let decision = decisions.get(paneKey)
    if (decision === undefined) {
      decision = isPutAwayRow(rowsByPaneKey.get(paneKey), view, archived)
      decisions.set(paneKey, decision)
    }
    return decision
  }
}
