import {
  parseSessionGridSnapshot,
  type SessionGridNote,
  type SessionGridSnapshot
} from './session-grid-panes'

export type SessionGridSavedLayout = { id: string; name: string; snapshot: SessionGridSnapshot }
export type SessionGridDocument = {
  version: 2
  layouts: SessionGridSavedLayout[]
  activeLayoutId: string
}
export type SessionGridStorageStatus =
  | 'absent'
  | 'healthy'
  | 'corrupt'
  | 'unsupported'
  | 'unwritable'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readGridNotes(value: unknown): Record<string, SessionGridNote> | null {
  if (!record(value)) {
    return null
  }
  for (const note of Object.values(value)) {
    if (
      !record(note) ||
      typeof note.title !== 'string' ||
      typeof note.text !== 'string' ||
      Object.keys(note).some((key) => key !== 'title' && key !== 'text')
    ) {
      return null
    }
  }
  return value as Record<string, SessionGridNote>
}

/** Refuse a lossy read; an editable projection must never replace the original. */
export function readGridSnapshot(value: unknown): SessionGridSnapshot | null {
  if (!record(value) || !record(value.panes) || !record(value.layout)) {
    return null
  }
  if ('notes' in value && !readGridNotes(value.notes)) {
    return null
  }
  const parsed = parseSessionGridSnapshot(value, true)
  const ids = Object.keys(value.panes)
  if (ids.length !== Object.keys(parsed.panes).length) {
    return null
  }
  const tracks = value.layout.tracks
  if (!Array.isArray(tracks) || tracks.some((track) => !Array.isArray(track))) {
    return null
  }
  if (tracks.some((track) => track.length > 4) || tracks.flat().length > 8) {
    return null
  }
  const rawShown = tracks.flat()
  if (rawShown.length !== parsed.layout.tracks.flat().length) {
    return null
  }
  if (ids.some((id) => !rawShown.includes(id) && !parsed.minimized.includes(id))) {
    // Orphans remain recoverable in the tray, including opaque future kinds.
    parsed.minimized.push(
      ...ids.filter((id) => !rawShown.includes(id) && !parsed.minimized.includes(id))
    )
  }
  return parsed
}

export function readGridDocument(
  value: unknown
):
  | { status: 'healthy'; document: SessionGridDocument }
  | { status: 'corrupt' | 'unsupported'; document: null } {
  if (!record(value)) {
    return { status: 'corrupt', document: null }
  }
  if (value.version !== 2) {
    return { status: 'unsupported', document: null }
  }
  if (!Array.isArray(value.layouts) || value.layouts.length === 0) {
    return { status: 'corrupt', document: null }
  }
  const layouts: SessionGridSavedLayout[] = []
  for (const entry of value.layouts) {
    if (
      !record(entry) ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      typeof entry.name !== 'string'
    ) {
      return { status: 'corrupt', document: null }
    }
    const snapshot = readGridSnapshot(entry.snapshot)
    if (!snapshot || layouts.some((layout) => layout.id === entry.id)) {
      return { status: 'corrupt', document: null }
    }
    layouts.push({ id: entry.id, name: entry.name, snapshot })
  }
  if (!layouts.some((entry) => entry.id === value.activeLayoutId)) {
    return { status: 'corrupt', document: null }
  }
  return {
    status: 'healthy',
    document: { version: 2, layouts, activeLayoutId: value.activeLayoutId as string }
  }
}

export function encodeGridSnapshot(snapshot: SessionGridSnapshot): object {
  return {
    ...snapshot,
    notes: {},
    panes: Object.fromEntries(
      Object.entries(snapshot.panes).map(([id, pane]) => [
        id,
        pane.kind === 'unavailable' ? pane.raw : pane
      ])
    )
  }
}

export function encodeGridDocument(document: SessionGridDocument): object {
  return {
    ...document,
    layouts: document.layouts.map((layout) => ({
      ...layout,
      snapshot: encodeGridSnapshot(layout.snapshot)
    }))
  }
}

export function gridDowngradeSnapshot(snapshot: SessionGridSnapshot): SessionGridSnapshot {
  const panes = Object.fromEntries(
    Object.entries(snapshot.panes).filter(
      ([, pane]) => pane.kind === 'session' || pane.kind === 'browser' || pane.kind === 'notepad'
    )
  )
  return parseSessionGridSnapshot({ ...snapshot, panes })
}
