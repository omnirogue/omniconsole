import { flashSessionGridPane } from './session-grid-pane-flash'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useSessionGrid, type SessionGridTarget } from '@/store/session-grid'
import { activateSidebarSession } from './activate-sidebar-session'
import { isSessionGridView, openCommandCenter } from './command-center-navigation'
import { openSessionGrid } from './session-grid-open'
import { conversationViewKey } from './conversation-view'
import { sessionGridPaneIds, type SessionGridDropZone } from './session-grid-layout'
import { sessionGridPresets } from './session-grid-presets'
import {
  sameSessionGridContent,
  sessionGridContentForSession,
  type SessionGridPaneContent
} from './session-grid-panes'
import {
  clearSessionGridDrag,
  getSessionGridDrag,
  sidebarSessionKeysInFlight,
  type SessionGridDragPayload
} from './session-grid-drag'
import { clearSessionSidebarDrag } from './session-sidebar-drag'
import { buildSidebarSessions, type SidebarSession } from './sidebar-sessions'

export function toastGridFull(skipped: number): void {
  toast.error(
    translate(
      'sessionGrid.full',
      'The grid holds 8 panes. Close or minimize one first ({{count}} not added).',
      { count: skipped }
    )
  )
}

function sessionsByKey(keys: readonly string[]): SidebarSession[] {
  const sessions = buildSidebarSessions(useAppStore.getState())
  return keys.flatMap((key) => {
    const session = sessions.find((candidate) => conversationViewKey(candidate) === key)
    return session ? [session] : []
  })
}

/** A pane's conversation is not open: open it, then come back to the grid showing it. */
export function resumeSessionInGrid(session: SidebarSession): void {
  void activateSidebarSession(session).then((opened) => {
    if (opened && opened.handled === 'opened') {
      openCommandCenter(useAppStore.getState())
    } else if (!opened) {
      toast.error(translate('sessionGrid.openFailed', 'This conversation could not be opened.'))
    }
  })
}

/**
 * Adds contents one after another: the first beside `target`, each next one beside the last on
 * the same side. Dropped on an empty grid, they land in its first arrangement (2×2 for four).
 */
export function addContentsToSessionGrid(
  contents: readonly SessionGridPaneContent[],
  target: SessionGridTarget
): string[] {
  const grid = useSessionGrid.getState()
  grid.load(useAppStore.getState().settings?.commandCenter === true)
  const wasEmpty = sessionGridPaneIds(useSessionGrid.getState().layout).length === 0
  const added: string[] = []
  let anchor = target
  let skipped = 0
  for (const content of contents) {
    const result = useSessionGrid.getState().addPane(content, anchor)
    if (result.status === 'full') {
      skipped += 1
      continue
    }
    if (result.status === 'shown' && useAppStore.getState().settings?.commandCenter) {
      flashSessionGridPane(result.paneId)
    }
    added.push(result.paneId)
    if (anchor && anchor.zone !== 'center') {
      anchor = { paneId: result.paneId, zone: anchor.zone }
    }
  }
  if (wasEmpty && added.length > 2) {
    const layout = useSessionGrid.getState().layout
    const preset = sessionGridPresets(sessionGridPaneIds(layout).length)[0]
    if (preset) {
      useSessionGrid.getState().applyPreset(preset)
    }
  }
  if (skipped > 0) {
    toastGridFull(skipped)
  }
  return added
}

/** While the Grid is on screen, a conversation already on it is focused there. */
export function focusSessionInGrid(session: SidebarSession): boolean {
  const state = useAppStore.getState()
  if (!isSessionGridView(state.activeView, state.settings?.commandCenter)) {
    return false
  }
  const grid = useSessionGrid.getState()
  const content = sessionGridContentForSession(session)
  const shown = sessionGridPaneIds(grid.layout)
  const pane = shown
    .map((id) => grid.panes[id])
    .find((candidate) => (candidate ? sameSessionGridContent(candidate, content) : false))
  if (!pane) {
    return false
  }
  grid.focusPane(pane.id)
  return true
}

/** "Show in grid" from a menu: adds (or finds) the content and opens the Grid on it. */
export function showInSessionGrid(content: SessionGridPaneContent): void {
  const added = addContentsToSessionGrid([content], null)
  if (added.length > 0) {
    openSessionGrid()
  }
}

/** "Show in Grid" on a terminal tab: its conversation joins the grid. */
export function showTerminalTabInGrid(tabId: string): void {
  const session = buildSidebarSessions(useAppStore.getState()).find(
    (candidate) => candidate.tabId === tabId && !candidate.unavailable
  )
  if (!session) {
    toast.error(translate('sessionGrid.noConversation', 'This tab has no conversation to show.'))
    return
  }
  showInSessionGrid(sessionGridContentForSession(session))
}

export function showSidebarSessionsInGrid(sessions: readonly SidebarSession[]): void {
  const added = addContentsToSessionGrid(sessions.map(sessionGridContentForSession), null)
  if (added.length > 0) {
    openSessionGrid()
  }
}

/** What a grid drop carries, read while the drag is over the grid. */
export type SessionGridDragCapture = {
  payload: SessionGridDragPayload | null
  sidebarKeys: string[]
}

/**
 * The drag in flight. Why capture during dragover: another surface's window drop listener can
 * clear the sidebar's in-flight record before this one's drop handler runs.
 */
export function captureSessionGridDrag(): SessionGridDragCapture {
  return { payload: getSessionGridDrag(), sidebarKeys: sidebarSessionKeysInFlight() }
}

/**
 * Commits whatever is being dragged onto the grid at `target` (null: the empty grid). Returns
 * whether a grid drag was in flight.
 */
export function dropOnSessionGrid(
  target: SessionGridTarget,
  captured: SessionGridDragCapture = captureSessionGridDrag()
): boolean {
  const { payload, sidebarKeys } = captured
  clearSessionGridDrag()
  clearSessionSidebarDrag()
  const grid = useSessionGrid.getState()
  if (payload?.kind === 'pane') {
    if (target && target.paneId !== payload.paneId) {
      grid.movePane(payload.paneId, target)
    }
    return true
  }
  if (payload?.kind === 'tray') {
    if (grid.restorePane(payload.paneId, target).status === 'full') {
      toastGridFull(1)
    }
    return true
  }
  const contents =
    payload?.kind === 'content'
      ? [payload.content]
      : sessionsByKey(sidebarKeys).map(sessionGridContentForSession)
  if (contents.length === 0) {
    return payload !== null || sidebarKeys.length > 0
  }
  if (useAppStore.getState().settings?.commandCenter && contents.length === 1) {
    const existing = sessionGridPaneIds(grid.layout).find((id) =>
      sameSessionGridContent(grid.panes[id]!, contents[0]!)
    )
    if (existing) {
      grid.focusPane(existing)
      flashSessionGridPane(existing)
      return true
    }
  }
  if (target?.zone === 'center' && contents.length === 1) {
    grid.replacePane(target.paneId, contents[0]!)
    return true
  }
  addContentsToSessionGrid(contents, target)
  return true
}

/** What a workspace split group shows, as grid content: its front conversation or browser tab. */
export function workspaceGroupGridContent(
  worktreeId: string,
  groupId: string
): SessionGridPaneContent | null {
  const state = useAppStore.getState()
  const group = state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === groupId)
  const tab = group?.activeTabId
    ? state.unifiedTabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.id === group.activeTabId
      )
    : undefined
  if (!tab) {
    return null
  }
  if (tab.contentType === 'browser') {
    return { kind: 'browser', worktreeId, browserTabId: tab.entityId, label: tab.label }
  }
  const tabId =
    tab.contentType === 'terminal'
      ? tab.entityId
      : tab.contentType === 'agent-session'
        ? tab.id
        : null
  if (!tabId) {
    return null
  }
  const session = buildSidebarSessions(state).find(
    (candidate) => candidate.tabId === tabId && candidate.worktreeId === worktreeId
  )
  return session ? sessionGridContentForSession(session) : null
}

/**
 * Conversations dropped on the workspace: they go into the Grid beside what that split shows,
 * so conversations from any workspace (and browser tabs) can share one screen.
 */
export function splitWorkspaceIntoSessionGrid(args: {
  worktreeId: string
  groupId: string
  zone: SessionGridDropZone
  sessionKeys: readonly string[]
}): void {
  const dropped = sessionsByKey(args.sessionKeys)
  if (dropped.length === 0) {
    toast.error(
      translate(
        'auto.components.tab.group.ChatSessionDropLayer.sessionUnavailable',
        'This conversation is no longer available.'
      )
    )
    return
  }
  const grid = useSessionGrid.getState()
  grid.load(useAppStore.getState().settings?.commandCenter === true)
  const current = workspaceGroupGridContent(args.worktreeId, args.groupId)
  // Why: the conversation already on screen dropped beside itself is not a second pane.
  const contents = dropped
    .map(sessionGridContentForSession)
    .filter((content) => !current || !sameSessionGridContent(current, content))
  if (contents.length === 0) {
    return
  }
  const [first, ...rest] = contents
  const result = grid.splitFromWorkspace(
    current,
    first!,
    args.zone === 'center' ? 'right' : args.zone
  )
  if (result.status === 'full') {
    toastGridFull(contents.length)
    return
  }
  addContentsToSessionGrid(rest, {
    paneId: result.paneId,
    zone: args.zone === 'center' ? 'right' : args.zone
  })
  openSessionGrid()
  // Why: a conversation that is not open yet has no terminal to show; open it and come back.
  for (const session of dropped) {
    if (!session.tabId && !session.unavailable) {
      resumeSessionInGrid(session)
      break
    }
  }
}
