import type { SessionSelection } from '@/components/sidebar/session-folders/session-multi-selection'
import { create } from 'zustand'

export const useSessionSelection = create<{
  keys: readonly string[]
  /** `keys` as a set, so each row answers "am I selected?" in O(1). */
  selected: ReadonlySet<string>
  anchor: string | null
  focus: string | null
  explicit: boolean
  scope: 'visible' | 'all'
  /** Folders picked with ⌘/Ctrl-click on their heading; they drag along with the selected sessions. */
  folderIds: ReadonlySet<string>
  toggleFolder: (folderId: string) => void
  clearFolders: () => void
  toggle: (key: string, scope?: 'visible' | 'all') => void
  set: (keys: readonly string[]) => void
  setGesture: (selection: SessionSelection, explicit: boolean) => void
}>((set) => ({
  keys: [],
  selected: new Set(),
  anchor: null,
  focus: null,
  explicit: false,
  scope: 'all',
  folderIds: new Set(),
  toggleFolder: (folderId) =>
    set((state) => {
      const folderIds = new Set(state.folderIds)
      if (folderIds.has(folderId)) {
        folderIds.delete(folderId)
      } else {
        folderIds.add(folderId)
      }
      return { folderIds }
    }),
  clearFolders: () => set((state) => (state.folderIds.size ? { folderIds: new Set() } : state)),
  toggle: (key, scope = 'all') =>
    set((state) => {
      const keys = state.selected.has(key)
        ? state.keys.filter((entry) => entry !== key)
        : [...state.keys, key]
      return { keys, selected: new Set(keys), anchor: key, focus: key, explicit: true, scope }
    }),
  set: (keys) => {
    const unique = [...new Set(keys)]
    set({
      keys: unique,
      selected: new Set(unique),
      anchor: keys[0] ?? null,
      focus: keys.at(-1) ?? null,
      explicit: keys.length > 0,
      scope: 'all',
      // Why: clearing the selection (Escape, after a bulk action) clears picked folders too.
      ...(keys.length === 0 ? { folderIds: new Set<string>() } : {})
    })
  },
  setGesture: (selection, explicit) =>
    set(() => ({
      keys: [...selection.selected],
      selected: new Set(selection.selected),
      anchor: selection.anchor,
      focus: selection.focus,
      explicit,
      scope: 'visible'
    }))
}))
