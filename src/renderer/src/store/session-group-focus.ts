import { create } from 'zustand'

/**
 * Idle clocks for groups waiting to fold down to focus, written in place by the ticker. Kept
 * outside the store's state on purpose: nothing renders from it.
 */
export const sessionGroupFocusIdleSince = new Map<string, number>()

/**
 * Which open groups currently list only the conversation in use (see session-group-focus).
 * Transient and per window: a restart, a new conversation on screen or "Show all" lists
 * everything again.
 */
type SessionGroupFocusState = {
  trimmed: ReadonlySet<string>
  trim: (keys: readonly string[]) => void
  /** List every row of a group again, and give it the full idle wait before it folds back. */
  showAll: (key: string) => void
  reset: () => void
}

export const useSessionGroupFocus = create<SessionGroupFocusState>((set, get) => ({
  trimmed: new Set(),
  trim: (keys) => {
    const trimmed = new Set(get().trimmed)
    for (const key of keys) {
      trimmed.add(key)
    }
    set({ trimmed })
  },
  showAll: (key) => {
    sessionGroupFocusIdleSince.delete(key)
    if (get().trimmed.has(key)) {
      const trimmed = new Set(get().trimmed)
      trimmed.delete(key)
      set({ trimmed })
    }
  },
  reset: () => {
    sessionGroupFocusIdleSince.clear()
    if (get().trimmed.size > 0) {
      set({ trimmed: new Set() })
    }
  }
}))
