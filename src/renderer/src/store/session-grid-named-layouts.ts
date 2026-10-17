import { normalizeSessionGridLayout } from '@/lib/session-grid-layout'
import { applyGridTemplate, type SessionGridTemplate } from '@/lib/session-grid-templates'
import type { SessionGridSavedLayout } from '@/lib/session-grid-document'
import type { SessionGridSnapshot } from '@/lib/session-grid-panes'
import type { SessionGridState } from './session-grid'

export type SessionGridNamedLayoutActions = {
  saveLayoutAs: (name: string) => void
  renameLayout: (id: string, name: string) => void
  deleteLayout: (id: string) => void
  switchLayout: (id: string) => void
  applyTemplate: (template: SessionGridTemplate) => void
  resetToDefault: () => void
  toggleOrientation: () => void
  maximizePane: (id: string | null) => void
}

export function gridSnapshot(state: SessionGridSnapshot): SessionGridSnapshot {
  const { panes, layout, minimized, focusedPaneId, notes } = state
  return { panes, layout, minimized, focusedPaneId, notes }
}

export function gridLayouts(
  state: SessionGridState,
  next = gridSnapshot(state)
): SessionGridSavedLayout[] {
  const notes = Object.assign({}, ...state.layouts.map((entry) => entry.snapshot.notes), next.notes)
  return state.layouts.map((entry) => ({
    ...entry,
    snapshot: { ...(entry.id === state.activeLayoutId ? next : entry.snapshot), notes }
  }))
}

export function createNamedGridActions(
  get: () => SessionGridState,
  set: (patch: Partial<SessionGridState>) => void,
  commit: (next: SessionGridSnapshot) => void,
  persist: () => void
): SessionGridNamedLayoutActions {
  return {
    saveLayoutAs: (name) => {
      const state = get()
      if (!state.commandCenter || !name.trim()) {
        return
      }
      const id = `layout-${crypto.randomUUID()}`
      set({
        layouts: [...gridLayouts(state), { id, name: name.trim(), snapshot: gridSnapshot(state) }],
        activeLayoutId: id
      })
      persist()
    },
    renameLayout: (id, name) => {
      if (!get().commandCenter || !name.trim()) {
        return
      }
      set({
        layouts: gridLayouts(get()).map((entry) =>
          entry.id === id ? { ...entry, name: name.trim() } : entry
        )
      })
      persist()
    },
    deleteLayout: (id) => {
      const state = get()
      if (!state.commandCenter || state.layouts.length <= 1) {
        return
      }
      const layouts = gridLayouts(state).filter((entry) => entry.id !== id)
      if (layouts.length === state.layouts.length) {
        return
      }
      const active = layouts.find((entry) => entry.id === state.activeLayoutId) ?? layouts[0]!
      set({ layouts, activeLayoutId: active.id, ...active.snapshot, maximizedPaneId: null })
      persist()
    },
    switchLayout: (id) => {
      const state = get()
      if (!state.commandCenter || id === state.activeLayoutId) {
        return
      }
      const layouts = gridLayouts(state)
      const entry = layouts.find((candidate) => candidate.id === id)
      if (!entry) {
        return
      }
      set({ layouts, activeLayoutId: id, ...entry.snapshot, maximizedPaneId: null })
      persist()
    },
    applyTemplate: (template) => {
      if (get().commandCenter) {
        set({ maximizedPaneId: null })
        commit(applyGridTemplate(gridSnapshot(get()), template))
      }
    },
    resetToDefault: () => get().applyTemplate('Default'),
    toggleOrientation: () => {
      if (!get().commandCenter) {
        return
      }
      const state = get()
      commit({
        ...gridSnapshot(state),
        layout: normalizeSessionGridLayout({
          ...state.layout,
          orientation: state.layout.orientation === 'columns' ? 'rows' : 'columns'
        })
      })
    },
    maximizePane: (id) => {
      if (get().commandCenter && (id === null || get().layout.tracks.flat().includes(id))) {
        set({ maximizedPaneId: id, focusedPaneId: id ?? get().focusedPaneId })
      }
    }
  }
}
