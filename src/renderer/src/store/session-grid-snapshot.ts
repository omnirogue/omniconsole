import {
  insertSessionGridPane,
  sessionGridPaneIds,
  SESSION_GRID_MAX_PANES
} from '@/lib/session-grid-layout'
import {
  sameSessionGridContent,
  type SessionGridPane,
  type SessionGridPaneContent,
  type SessionGridSnapshot
} from '@/lib/session-grid-panes'
import type { SessionGridState, SessionGridTarget, SessionGridAddResult } from './session-grid'
const MAX_MINIMIZED = 16
export function newPaneId(): string {
  return `pane-${crypto.randomUUID()}`
}

export function findPane(
  state: SessionGridSnapshot,
  content: SessionGridPaneContent
): SessionGridPane | null {
  return Object.values(state.panes).find((pane) => sameSessionGridContent(pane, content)) ?? null
}

export function isShown(state: SessionGridSnapshot, paneId: string): boolean {
  return sessionGridPaneIds(state.layout).includes(paneId)
}

/** Drops panes that are neither shown nor in the tray, and trims the tray. */
export function prune(state: SessionGridSnapshot, commandCenter = false): SessionGridSnapshot {
  const shown = new Set(sessionGridPaneIds(state.layout))
  let ordinary = 0
  const protectedPane = (pane: SessionGridPane | undefined): boolean =>
    pane?.kind === 'unavailable' || (pane?.kind === 'view' && pane.viewId === 'ready')
  const candidates = commandCenter
    ? [
        ...new Set([
          ...state.minimized,
          ...Object.values(state.panes)
            .filter((pane) => protectedPane(pane))
            .map((pane) => pane.id)
        ])
      ]
    : state.minimized
  const minimized = candidates
    .filter((id) => !shown.has(id))
    .filter((id) =>
      commandCenter && protectedPane(state.panes[id]) ? true : ordinary++ < MAX_MINIMIZED
    )
  const kept = new Set([...shown, ...minimized])
  const panes = Object.fromEntries(Object.entries(state.panes).filter(([id]) => kept.has(id)))
  const noteIds = new Set(
    Object.values(panes).flatMap((pane) => (pane.kind === 'notepad' ? [pane.noteId] : []))
  )
  const notes = Object.fromEntries(Object.entries(state.notes).filter(([id]) => noteIds.has(id)))
  const focusedPaneId =
    state.focusedPaneId && shown.has(state.focusedPaneId)
      ? state.focusedPaneId
      : ([...shown][0] ?? null)
  return { ...state, panes, minimized, notes, focusedPaneId }
}

export function snapshotOf(state: SessionGridState): SessionGridSnapshot {
  const { panes, layout, minimized, focusedPaneId, notes } = state
  return { panes, layout, minimized, focusedPaneId, notes }
}

/** Places a pane (new or from the tray) into the layout, or reports the grid full. */
export function place(
  state: SessionGridSnapshot,
  pane: SessionGridPane,
  target: SessionGridTarget,
  commandCenter = false
): { next: SessionGridSnapshot; result: SessionGridAddResult } {
  if (sessionGridPaneIds(state.layout).length >= SESSION_GRID_MAX_PANES) {
    return { next: state, result: { status: 'full', paneId: null } }
  }
  const layout = insertSessionGridPane(state.layout, pane.id, target)
  return {
    next: prune(
      {
        ...state,
        panes: { ...state.panes, [pane.id]: pane },
        layout,
        minimized: state.minimized.filter((id) => id !== pane.id),
        focusedPaneId: pane.id
      },
      commandCenter
    ),
    result: { status: 'added', paneId: pane.id }
  }
}
