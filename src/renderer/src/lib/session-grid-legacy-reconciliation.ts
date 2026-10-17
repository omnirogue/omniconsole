import { gridDowngradeSnapshot, type SessionGridDocument } from './session-grid-document'
import { appendSessionGridPane, SESSION_GRID_MAX_PANES } from './session-grid-layout'
import type { SessionGridSnapshot } from './session-grid-panes'

export function gridDocumentNotes(document: SessionGridDocument): SessionGridSnapshot['notes'] {
  return Object.assign({}, ...document.layouts.map((entry) => entry.snapshot.notes))
}

/** The legacy grid owns rollback edits; named layouts and v2-only panes remain recoverable. */
export function reconcileLegacyGrid(
  document: SessionGridDocument,
  legacy: SessionGridSnapshot,
  legacyRaw: string,
  mirrored: string | null
): SessionGridDocument {
  const active = document.layouts.find((entry) => entry.id === document.activeLayoutId)!
  const notes = gridDocumentNotes(document)
  const projected = gridDowngradeSnapshot({ ...active.snapshot, notes })
  if (legacyRaw === (mirrored ?? JSON.stringify(projected))) {
    return document
  }
  let snapshot = active.snapshot
  if (JSON.stringify({ ...legacy, notes: {} }) !== JSON.stringify({ ...projected, notes: {} })) {
    const exclusive = Object.fromEntries(
      Object.entries(snapshot.panes).filter(
        ([, pane]) => pane.kind === 'view' || pane.kind === 'unavailable'
      )
    )
    let layout = legacy.layout
    const minimized = [...legacy.minimized]
    for (const id of Object.keys(exclusive)) {
      if (legacy.panes[id]) {
        continue
      }
      if (
        snapshot.layout.tracks.flat().includes(id) &&
        layout.tracks.flat().length < SESSION_GRID_MAX_PANES
      ) {
        layout = appendSessionGridPane(layout, id)
      } else {
        minimized.push(id)
      }
    }
    snapshot = {
      ...legacy,
      panes: { ...exclusive, ...legacy.panes },
      layout,
      minimized: [...new Set(minimized)]
    }
  }
  const mergedNotes = { ...notes, ...legacy.notes }
  return {
    ...document,
    layouts: document.layouts.map((entry) => ({
      ...entry,
      snapshot: {
        ...(entry.id === document.activeLayoutId ? snapshot : entry.snapshot),
        notes: mergedNotes
      }
    }))
  }
}
