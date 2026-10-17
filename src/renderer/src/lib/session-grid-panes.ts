import {
  emptySessionGridLayout,
  normalizeSessionGridLayout,
  type SessionGridLayout
} from './session-grid-layout'
import type { SidebarSession } from './sidebar-sessions'
import { conversationViewKey } from './conversation-view'

/** What a Grid pane shows. Ids are hints kept to find the live thing again. */
export type SessionGridPaneContent =
  | {
      kind: 'session'
      worktreeId: string
      /** Terminal tab id (a structured chat's unified tab id) when it was placed. */
      tabId: string | null
      paneKey: string | null
      /** The conversation's view key; it outlives a tab that closes and is resumed. */
      sessionKey: string
      executionHostId?: string | null
      label: string
    }
  | { kind: 'browser'; worktreeId: string; browserTabId: string; label: string }
  | { kind: 'notepad'; noteId: string }
  | { kind: 'view'; viewId: string; selectDefault?: boolean }
  | { kind: 'unavailable'; raw: Record<string, unknown> }

export type SessionGridPane = SessionGridPaneContent & { id: string }

export type SessionGridNote = { title: string; text: string }

export type SessionGridSnapshot = {
  panes: Record<string, SessionGridPane>
  layout: SessionGridLayout
  /** Panes folded into the tray, most recent first. */
  minimized: string[]
  focusedPaneId: string | null
  notes: Record<string, SessionGridNote>
}

export function sessionGridContentForSession(session: SidebarSession): SessionGridPaneContent {
  return {
    kind: 'session',
    worktreeId: session.worktreeId,
    tabId: session.tabId,
    paneKey: session.paneKey,
    sessionKey: conversationViewKey(session),
    executionHostId: session.hostId,
    label: session.label
  }
}

/** Whether two contents show the same thing, so a conversation is never in the grid twice. */
export function sameSessionGridContent(
  left: SessionGridPaneContent,
  right: SessionGridPaneContent
): boolean {
  if (left.kind === 'session' && right.kind === 'session') {
    if (left.sessionKey === right.sessionKey) {
      return true
    }
    if (!left.executionHostId || left.executionHostId !== right.executionHostId) {
      return false
    }
    if (left.paneKey && left.paneKey === right.paneKey) {
      return true
    }
    // Why: one terminal tab is one live pane on screen, whichever split inside it was dropped.
    return left.tabId !== null && left.tabId === right.tabId && left.worktreeId === right.worktreeId
  }
  if (left.kind === 'browser' && right.kind === 'browser') {
    return left.browserTabId === right.browserTabId
  }
  if (left.kind === 'notepad' && right.kind === 'notepad') {
    return left.noteId === right.noteId
  }
  if (left.kind === 'view' && right.kind === 'view') {
    return (
      left.viewId === right.viewId &&
      !['session-chooser', 'ready', 'browser', 'terminal'].includes(left.viewId)
    )
  }
  return false
}

/**
 * Resolve the host-qualified view key first, then host-qualified pane and tab hints.
 */
export function resolveSessionGridSession(
  content: Extract<SessionGridPaneContent, { kind: 'session' }>,
  sessions: readonly SidebarSession[]
): SidebarSession | null {
  const byKey = sessions.find((session) => conversationViewKey(session) === content.sessionKey)
  if (byKey && (!content.executionHostId || byKey.hostId === content.executionHostId)) {
    return byKey
  }
  if (!content.executionHostId) {
    return null
  }
  if (content.paneKey) {
    const byPane = sessions.find(
      (session) => session.hostId === content.executionHostId && session.paneKey === content.paneKey
    )
    if (byPane) {
      return byPane
    }
  }
  if (content.tabId) {
    return (
      sessions.find(
        (session) =>
          session.hostId === content.executionHostId &&
          session.tabId === content.tabId &&
          session.worktreeId === content.worktreeId &&
          !session.unavailable
      ) ?? null
    )
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parsePane(id: string, value: unknown, preserveUnknown: boolean): SessionGridPane | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.kind === 'session') {
    const worktreeId = readString(value.worktreeId)
    const sessionKey = readString(value.sessionKey)
    if (!worktreeId || !sessionKey) {
      return null
    }
    return {
      id,
      kind: 'session',
      worktreeId,
      tabId: readString(value.tabId),
      paneKey: readString(value.paneKey),
      sessionKey,
      executionHostId: readString(value.executionHostId),
      label: readString(value.label) ?? ''
    }
  }
  if (value.kind === 'browser') {
    const worktreeId = readString(value.worktreeId)
    const browserTabId = readString(value.browserTabId)
    return worktreeId && browserTabId
      ? { id, kind: 'browser', worktreeId, browserTabId, label: readString(value.label) ?? '' }
      : null
  }
  if (value.kind === 'notepad') {
    const noteId = readString(value.noteId)
    return noteId ? { id, kind: 'notepad', noteId } : null
  }
  if (preserveUnknown && value.kind === 'view' && readString(value.viewId)) {
    return {
      id,
      kind: 'view',
      viewId: value.viewId as string,
      ...(value.selectDefault === true ? { selectDefault: true } : {})
    }
  }
  return preserveUnknown && readString(value.kind) ? { id, kind: 'unavailable', raw: value } : null
}

function parseLayout(value: unknown, known: ReadonlySet<string>): SessionGridLayout {
  if (!isRecord(value) || !Array.isArray(value.tracks)) {
    return emptySessionGridLayout()
  }
  const seen = new Set<string>()
  const tracks = value.tracks.map((track) =>
    Array.isArray(track)
      ? track.filter((id): id is string => {
          if (typeof id !== 'string' || !known.has(id) || seen.has(id)) {
            return false
          }
          seen.add(id)
          return true
        })
      : []
  )
  const shares = (raw: unknown): number[] | undefined =>
    Array.isArray(raw) && raw.every((share) => typeof share === 'number') ? raw : undefined
  return normalizeSessionGridLayout({
    orientation: value.orientation === 'rows' ? 'rows' : 'columns',
    tracks,
    trackSizes: shares(value.trackSizes) ?? [],
    paneSizes: Array.isArray(value.paneSizes)
      ? value.paneSizes.map((sizes) => shares(sizes) ?? [])
      : []
  })
}

/** Reads a saved grid defensively: anything malformed is dropped, never thrown. */
export function parseSessionGridSnapshot(
  value: unknown,
  preserveUnknown = false
): SessionGridSnapshot {
  if (!isRecord(value)) {
    return {
      panes: {},
      layout: emptySessionGridLayout(),
      minimized: [],
      focusedPaneId: null,
      notes: {}
    }
  }
  const panes: Record<string, SessionGridPane> = {}
  if (isRecord(value.panes)) {
    for (const [id, raw] of Object.entries(value.panes)) {
      const pane = parsePane(id, raw, preserveUnknown)
      if (pane) {
        panes[id] = pane
      }
    }
  }
  const known = new Set(Object.keys(panes))
  const layout = parseLayout(value.layout, known)
  const shown = new Set(layout.tracks.flat())
  const minimized = Array.isArray(value.minimized)
    ? value.minimized.filter(
        (id): id is string => typeof id === 'string' && known.has(id) && !shown.has(id)
      )
    : []
  const notes: Record<string, SessionGridNote> = {}
  if (isRecord(value.notes)) {
    for (const [id, raw] of Object.entries(value.notes)) {
      if (isRecord(raw)) {
        notes[id] = {
          title: typeof raw.title === 'string' ? raw.title : '',
          text: typeof raw.text === 'string' ? raw.text : ''
        }
      }
    }
  }
  const focused = readString(value.focusedPaneId)
  return {
    panes,
    layout,
    minimized: [...new Set(minimized)],
    focusedPaneId: focused && shown.has(focused) ? focused : null,
    notes
  }
}
