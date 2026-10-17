/**
 * Where `omni session show` puts a conversation so the person keeps what they were looking at:
 * split right in the workspace on screen, else the Grid with the current view on the left.
 */

import { useAppStore, type AppState } from '@/store'
import { useSessionGrid } from '@/store/session-grid'
import type { SessionShowPlacement } from '../../../shared/session-show'
import { resumeSessionInGrid, workspaceGroupGridContent } from './session-grid-actions'
import { sessionGridPaneIds } from './session-grid-layout'
import { isSessionGridView } from './command-center-navigation'
import { openSessionGrid } from './session-grid-open'
import {
  sameSessionGridContent,
  sessionGridContentForSession,
  type SessionGridPaneContent
} from './session-grid-panes'
import type { SidebarSession } from './sidebar-sessions'

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel'])

/** A composer, text field or code editor with keyboard focus and something typed but not sent. */
export function isTypingUnsentText(element: Element | null): boolean {
  if (!element || !(element instanceof HTMLElement)) {
    return false
  }
  // Why: xterm's input textarea is always empty; what a shell prompt holds lives in the PTY.
  if (element.classList.contains('xterm-helper-textarea')) {
    return false
  }
  if (element.closest('.monaco-editor')) {
    return true
  }
  if (element instanceof HTMLTextAreaElement) {
    return element.value.trim().length > 0
  }
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) && element.value.trim().length > 0
  }
  return element.isContentEditable && (element.textContent ?? '').trim().length > 0
}

/**
 * The shown pane to give up when the Grid is full: the one focused longest ago (never-focused
 * ones first, in layout order), and never one in `keep`.
 */
export function leastRecentGridPane(
  shown: readonly string[],
  recent: readonly string[],
  keep: ReadonlySet<string>
): string | null {
  const rank = (id: string): number => {
    const index = recent.indexOf(id)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  let oldest: string | null = null
  for (const id of shown) {
    if (!keep.has(id) && (oldest === null || rank(id) > rank(oldest))) {
      oldest = id
    }
  }
  return oldest
}

/** The unified tab behind a sidebar row: a terminal row names its terminal tab (`entityId`). */
function unifiedTabFor(state: AppState, session: SidebarSession) {
  return (state.unifiedTabsByWorktree[session.worktreeId] ?? []).find((tab) =>
    session.kind === 'structured'
      ? tab.id === session.tabId && tab.contentType === 'agent-session'
      : tab.entityId === session.tabId && tab.contentType === 'terminal'
  )
}

/**
 * In the workspace on screen: already in front in one of its splits, or moved into a new split
 * on the right of the focused one (the same move as dropping its tab on that edge). Null when the
 * target lives elsewhere or the move could not be made.
 */
export function placeBesideInWorkspace(
  session: SidebarSession
): Extract<SessionShowPlacement, 'split' | 'already-shown'> | null {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (state.activeView !== 'terminal' || worktreeId !== session.worktreeId || !session.tabId) {
    return null
  }
  const tab = unifiedTabFor(state, session)
  if (!tab) {
    return null
  }
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (groups.find((group) => group.id === tab.groupId)?.activeTabId === tab.id) {
    return 'already-shown'
  }
  const currentGroupId = state.activeGroupIdByWorktree[worktreeId]
  if (!currentGroupId) {
    return null
  }
  return state.dropUnifiedTab(tab.id, { groupId: currentGroupId, splitDirection: 'right' })
    ? 'split'
    : null
}

function currentWorkspaceContent(state: AppState): SessionGridPaneContent | null {
  const worktreeId = state.activeWorktreeId
  const groupId = worktreeId ? state.activeGroupIdByWorktree[worktreeId] : undefined
  if (state.activeView !== 'terminal' || !worktreeId || !groupId) {
    return null
  }
  return workspaceGroupGridContent(worktreeId, groupId)
}

/**
 * The Grid, with what is on screen on the left and the target on its right. A full Grid gives up
 * its least recently used pane, never the current one.
 */
export function placeBesideInGrid(
  session: SidebarSession
): Extract<SessionShowPlacement, 'grid' | 'grid-replaced' | 'already-shown'> {
  const state = useAppStore.getState()
  useSessionGrid.getState().load(useAppStore.getState().settings?.commandCenter === true)
  const content = sessionGridContentForSession(session)
  const inGrid = isSessionGridView(state.activeView, state.settings?.commandCenter)
  const current = inGrid ? null : currentWorkspaceContent(state)
  const focusedId = inGrid ? useSessionGrid.getState().focusedPaneId : null
  // Why addPane without a workspace in front: folding the Grid away would drop what someone built.
  const result = current
    ? useSessionGrid.getState().splitFromWorkspace(current, content, 'right')
    : useSessionGrid
        .getState()
        .addPane(content, focusedId ? { paneId: focusedId, zone: 'right' } : null)
  let placement: 'grid' | 'grid-replaced' | 'already-shown' =
    inGrid && result.status === 'shown' ? 'already-shown' : 'grid'
  if (result.status === 'full') {
    const grid = useSessionGrid.getState()
    const keepId = current
      ? (Object.values(grid.panes).find((pane) => sameSessionGridContent(pane, current))?.id ??
        null)
      : focusedId
    const replaced = leastRecentGridPane(
      sessionGridPaneIds(grid.layout),
      grid.recentPaneIds,
      new Set(keepId ? [keepId] : [])
    )
    if (!replaced) {
      throw new Error('The Grid is full and has no pane to give up.')
    }
    grid.replacePane(replaced, content)
    placement = 'grid-replaced'
  }
  openSessionGrid()
  // Why: a conversation that is not open yet has no terminal to show; open it and come back.
  if (!session.tabId && !session.unavailable) {
    resumeSessionInGrid(session)
  }
  return placement
}
