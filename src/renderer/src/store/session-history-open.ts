import { create } from 'zustand'

/** Rows whose History the person opened from the row menu; in memory, this window only. */
export const useSessionHistoryOpen = create<{
  open: ReadonlySet<string>
  setOpen: (key: string, open: boolean) => void
}>((set) => ({
  open: new Set(),
  setOpen: (key, open) =>
    set((state) => {
      if (state.open.has(key) === open) {
        return state
      }
      const next = new Set(state.open)
      if (open) {
        next.add(key)
      } else {
        next.delete(key)
      }
      return { open: next }
    })
}))
