import { applySessionGridPreset } from '@/lib/session-grid-presets'
import {
  emptySessionGridLayout,
  moveSessionGridPane,
  normalizeSessionGridLayout,
  removeSessionGridPane,
  replaceSessionGridPane,
  sessionGridPaneIds
} from '@/lib/session-grid-layout'
import type { SessionGridSnapshot } from '@/lib/session-grid-panes'
import type { SessionGridState } from './session-grid'
import { newPaneId, snapshotOf, findPane, isShown, prune, place } from './session-grid-snapshot'
export function createGridPaneActions(
  get: () => SessionGridState,
  commit: (next: SessionGridSnapshot, focusOnly?: boolean, notesOnly?: boolean) => void
): Pick<
  SessionGridState,
  | 'addPane'
  | 'replacePane'
  | 'removePane'
  | 'minimizePane'
  | 'restorePane'
  | 'movePane'
  | 'applyPreset'
  | 'setLayoutSizes'
  | 'focusPane'
  | 'setNote'
  | 'splitFromWorkspace'
> {
  return {
    addPane: (content, target = null) => {
      const state = snapshotOf(get())
      const existing = findPane(state, content)
      if (existing && isShown(state, existing.id)) {
        commit({ ...state, focusedPaneId: existing.id }, true)
        return { status: 'shown', paneId: existing.id }
      }
      const pane = existing ?? { ...content, id: newPaneId() }
      const { next, result } = place(state, pane, target, get().commandCenter)
      if (result.status === 'added') {
        commit(next)
      }
      return result
    },
    replacePane: (paneId, content) => {
      const state = snapshotOf(get())
      if (!state.panes[paneId]) {
        return
      }
      const existing = findPane(state, content)
      if (existing && isShown(state, existing.id)) {
        // Why: dropping a pane's own content on another pane swaps the two.
        commit({
          ...state,
          layout: moveSessionGridPane(state.layout, existing.id, { paneId, zone: 'center' }),
          focusedPaneId: existing.id
        })
        return
      }
      const pane = existing ?? { ...content, id: newPaneId() }
      commit(
        prune(
          {
            ...state,
            panes: { ...state.panes, [pane.id]: pane },
            layout: replaceSessionGridPane(state.layout, paneId, pane.id),
            minimized: state.minimized.filter((id) => id !== pane.id),
            focusedPaneId: pane.id
          },
          get().commandCenter
        )
      )
    },
    removePane: (paneId) => {
      const state = snapshotOf(get())
      if (get().commandCenter) {
        state.panes = Object.fromEntries(
          Object.entries(state.panes).filter(([id]) => id !== paneId)
        )
      }
      commit(
        prune(
          {
            ...state,
            layout: removeSessionGridPane(state.layout, paneId),
            minimized: state.minimized.filter((id) => id !== paneId)
          },
          get().commandCenter
        )
      )
    },
    minimizePane: (paneId) => {
      const state = snapshotOf(get())
      if (!isShown(state, paneId)) {
        return
      }
      commit(
        prune(
          {
            ...state,
            layout: removeSessionGridPane(state.layout, paneId),
            minimized: [paneId, ...state.minimized.filter((id) => id !== paneId)]
          },
          get().commandCenter
        )
      )
    },
    restorePane: (paneId, target = null) => {
      const state = snapshotOf(get())
      const pane = state.panes[paneId]
      if (!pane) {
        return { status: 'full', paneId: null }
      }
      if (isShown(state, paneId)) {
        commit({ ...state, focusedPaneId: paneId }, true)
        return { status: 'shown', paneId }
      }
      const { next, result } = place(state, pane, target, get().commandCenter)
      if (result.status === 'added') {
        commit(next)
      }
      return result
    },
    movePane: (paneId, target) => {
      const state = snapshotOf(get())
      commit({
        ...state,
        layout: moveSessionGridPane(state.layout, paneId, target),
        focusedPaneId: paneId
      })
    },
    applyPreset: (preset) => {
      const state = snapshotOf(get())
      commit({ ...state, layout: applySessionGridPreset(state.layout, preset) })
    },
    setLayoutSizes: (sizes) => {
      const state = snapshotOf(get())
      commit({
        ...state,
        layout: normalizeSessionGridLayout({ ...state.layout, ...sizes })
      })
    },
    focusPane: (paneId) => {
      if (get().focusedPaneId !== paneId) {
        commit({ ...snapshotOf(get()), focusedPaneId: paneId }, true)
      }
    },
    setNote: (noteId, patch) => {
      const state = snapshotOf(get())
      const note = state.notes[noteId] ?? { title: '', text: '' }
      commit({ ...state, notes: { ...state.notes, [noteId]: { ...note, ...patch } } }, false, true)
    },
    splitFromWorkspace: (current, dropped, zone) => {
      let state = snapshotOf(get())
      const anchor = current ? findPane(state, current) : null
      if (!anchor || !isShown(state, anchor.id)) {
        // Why: never lose a grid someone built — it waits in the tray, one click from back.
        const shownIds = sessionGridPaneIds(state.layout)
        state = {
          ...state,
          layout: emptySessionGridLayout(),
          minimized: [...shownIds, ...state.minimized]
        }
        if (current) {
          const pane = anchor ?? { ...current, id: newPaneId() }
          state = place(state, pane, null, get().commandCenter).next
        }
      }
      const anchorId = current ? (findPane(state, current)?.id ?? null) : null
      const existing = findPane(state, dropped)
      if (existing && isShown(state, existing.id)) {
        if (anchorId && anchorId !== existing.id) {
          state = {
            ...state,
            layout: moveSessionGridPane(state.layout, existing.id, { paneId: anchorId, zone })
          }
        }
        commit({ ...state, focusedPaneId: existing.id })
        return { status: 'shown', paneId: existing.id }
      }
      const pane = existing ?? { ...dropped, id: newPaneId() }
      const { next, result } = place(
        state,
        pane,
        anchorId ? { paneId: anchorId, zone } : null,
        get().commandCenter
      )
      commit(result.status === 'added' ? next : state)
      return result
    }
  }
}
