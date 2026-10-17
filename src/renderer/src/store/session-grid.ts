import { createGridPaneActions } from './session-grid-pane-actions'
import { snapshotOf, isShown } from './session-grid-snapshot'
import { create } from 'zustand'
import type { SessionGridPreset } from '@/lib/session-grid-presets'
import {
  emptySessionGridLayout,
  type SessionGridDropZone,
  type SessionGridLayout
} from '@/lib/session-grid-layout'
import type { SessionGridPaneContent, SessionGridSnapshot } from '@/lib/session-grid-panes'
import {
  createGridWriter,
  loadGridDocument,
  SESSION_GRID_V2_STORAGE_KEY
} from './session-grid-persistence'
import {
  createNamedGridActions,
  gridLayouts,
  type SessionGridNamedLayoutActions
} from './session-grid-named-layouts'
import {
  readGridSnapshot,
  type SessionGridSavedLayout,
  type SessionGridStorageStatus
} from '@/lib/session-grid-document'
import { personalViewStorageKey, readPersonalView } from '@/lib/personal-view-storage'

export const SESSION_GRID_STORAGE_KEY = 'omni.session-grid.v1'
const RECENT_PANES_KEPT = 64

export type SessionGridTarget = { paneId: string; zone: SessionGridDropZone } | null

export type SessionGridAddResult =
  | { status: 'added' | 'shown'; paneId: string }
  | { status: 'full'; paneId: null }

export type SessionGridState = SessionGridSnapshot &
  SessionGridNamedLayoutActions & {
    commandCenter: boolean
    layouts: SessionGridSavedLayout[]
    activeLayoutId: string
    storageStatus: SessionGridStorageStatus
    writeBlocked: boolean
    storageScope: string | null
    maximizedPaneId: string | null
    retryWrites: () => void
    flushWrites: () => void
    cancelPendingWrites: () => void
    loaded: boolean
    /** Pane ids, most recently focused first; this window only, never saved. */
    recentPaneIds: string[]
    load: (commandCenter?: boolean) => void
    /** Puts content in the grid beside `target`; content already there is shown instead. */
    addPane: (content: SessionGridPaneContent, target?: SessionGridTarget) => SessionGridAddResult
    /** Shows new content in a pane's place; the content it held leaves the grid. */
    replacePane: (paneId: string, content: SessionGridPaneContent) => void
    removePane: (paneId: string) => void
    minimizePane: (paneId: string) => void
    restorePane: (paneId: string, target?: SessionGridTarget) => SessionGridAddResult
    movePane: (paneId: string, target: { paneId: string; zone: SessionGridDropZone }) => void
    applyPreset: (preset: SessionGridPreset) => void
    setLayoutSizes: (sizes: Pick<SessionGridLayout, 'trackSizes' | 'paneSizes'>) => void
    focusPane: (paneId: string | null) => void
    setNote: (noteId: string, patch: { title?: string; text?: string }) => void
    /**
     * A conversation dropped on the workspace: it goes beside what is on screen. When that is
     * already in the grid the grid grows; otherwise the old grid folds into the tray and a new one
     * starts from the two.
     */
    splitFromWorkspace: (
      current: SessionGridPaneContent | null,
      dropped: SessionGridPaneContent,
      zone: SessionGridDropZone
    ) => SessionGridAddResult
  }

function emptySnapshot(): SessionGridSnapshot {
  return {
    panes: {},
    layout: emptySessionGridLayout(),
    minimized: [],
    focusedPaneId: null,
    notes: {}
  }
}

function save(snapshot: SessionGridSnapshot): SessionGridStorageStatus {
  try {
    const raw = readPersonalView(localStorage, SESSION_GRID_STORAGE_KEY)
    let previous: SessionGridSnapshot | null = null
    if (raw !== null) {
      try {
        previous = readGridSnapshot(JSON.parse(raw))
      } catch {
        return 'corrupt'
      }
      if (!previous) {
        return 'corrupt'
      }
    }
    localStorage.setItem(
      personalViewStorageKey(SESSION_GRID_STORAGE_KEY),
      JSON.stringify({ ...snapshot, notes: { ...previous?.notes, ...snapshot.notes } })
    )
    return 'healthy'
  } catch {
    return 'unwritable'
  }
}

export const useSessionGrid = create<SessionGridState>((set, get) => {
  const writer = createGridWriter((storageStatus) =>
    set({
      storageStatus,
      ...(['corrupt', 'unsupported'].includes(storageStatus) ? { writeBlocked: true } : {})
    })
  )
  const persistLegacy = (snapshot: SessionGridSnapshot): void => {
    if (!get().writeBlocked) {
      const storageStatus = save(snapshot)
      set({ storageStatus, writeBlocked: storageStatus === 'corrupt' })
    }
  }
  const persist = (notesOnly = false): void => {
    const state = get()
    if (!state.writeBlocked) {
      writer.schedule(
        { version: 2, activeLayoutId: state.activeLayoutId, layouts: gridLayouts(state) },
        notesOnly
      )
    }
  }
  const commit = (next: SessionGridSnapshot, focusOnly = false, notesOnly = false): void => {
    const focused = next.focusedPaneId
    const recent = get().recentPaneIds
    set({
      ...next,
      recentPaneIds: focused
        ? [focused, ...recent.filter((id) => id !== focused)].slice(0, RECENT_PANES_KEPT)
        : recent
    })
    if (get().commandCenter) {
      set({
        layouts: gridLayouts(get(), next),
        maximizedPaneId:
          get().maximizedPaneId &&
          isShown(next, get().maximizedPaneId!) &&
          (!focused || focused === get().maximizedPaneId)
            ? get().maximizedPaneId
            : null
      })
      if (!focusOnly) {
        persist(notesOnly)
      }
    } else {
      persistLegacy(next)
    }
  }
  return {
    ...emptySnapshot(),
    ...createNamedGridActions(get, set, commit, persist),
    commandCenter: false,
    layouts: [],
    activeLayoutId: 'default',
    storageStatus: 'absent',
    writeBlocked: false,
    storageScope: null,
    maximizedPaneId: null,
    retryWrites: () => {
      if (get().commandCenter) {
        persist()
      } else {
        persistLegacy(snapshotOf(get()))
      }
    },
    flushWrites: writer.flush,
    cancelPendingWrites: writer.cancel,
    loaded: false,
    recentPaneIds: [],
    load: (commandCenter = false) => {
      const storageScope = personalViewStorageKey(
        commandCenter ? SESSION_GRID_V2_STORAGE_KEY : SESSION_GRID_STORAGE_KEY
      )
      if (
        get().loaded &&
        get().commandCenter === commandCenter &&
        get().storageScope === storageScope
      ) {
        return
      }
      if (get().commandCenter) {
        writer.flush()
      }
      if (commandCenter) {
        const pending = writer.readPending(storageScope!)
        const { document, status, blocked } = loadGridDocument(emptySnapshot(), pending)
        const active = document.layouts.find((entry) => entry.id === document.activeLayoutId)!
        set({
          ...active.snapshot,
          layouts: document.layouts,
          activeLayoutId: document.activeLayoutId,
          commandCenter,
          loaded: true,
          storageScope,
          storageStatus: status,
          writeBlocked: blocked,
          maximizedPaneId: null,
          recentPaneIds: []
        })
        if (!blocked) {
          persist()
        }
        return
      }
      let snapshot = emptySnapshot()
      let storageStatus: SessionGridStorageStatus = 'absent'
      let writeBlocked = false
      let raw: string | null = null
      try {
        raw = readPersonalView(localStorage, SESSION_GRID_STORAGE_KEY)
      } catch {
        storageStatus = 'unwritable'
        writeBlocked = true
      }
      if (raw !== null) {
        try {
          const parsed = readGridSnapshot(JSON.parse(raw))
          if (!parsed) {
            throw new Error('Invalid grid')
          }
          snapshot = parsed
          storageStatus = 'healthy'
        } catch {
          storageStatus = 'corrupt'
          writeBlocked = true
        }
      }
      set({
        ...snapshot,
        loaded: true,
        commandCenter: false,
        storageScope,
        layouts: [],
        maximizedPaneId: null,
        storageStatus,
        writeBlocked
      })
    },
    ...createGridPaneActions(get, commit)
  }
})

/** A fresh notepad's content. */
export function newSessionGridNotepad(): SessionGridPaneContent {
  return { kind: 'notepad', noteId: `note-${crypto.randomUUID()}` }
}
