import { create } from 'zustand'

const PREFERRED_KEY = 'omni.rightPanel.sessionWorkPreferred.v1'

function readPreferred(): boolean {
  try {
    return window.localStorage.getItem(PREFERRED_KEY) !== '0'
  } catch {
    return true
  }
}

function writePreferred(preferred: boolean): void {
  try {
    // Why store only the opt-out: the default (Session work first) needs no write.
    if (preferred) {
      window.localStorage.removeItem(PREFERRED_KEY)
    } else {
      window.localStorage.setItem(PREFERRED_KEY, '0')
    }
  } catch {
    // Storage can be full or blocked; the choice then lasts for this run only.
  }
}

type SessionWorkViewState = {
  /**
   * Whether the right panel shows the on-screen session's work (rather than a developer tab) when
   * a person opens it. Per device and across sessions, so every session reads the same way.
   */
  preferred: boolean
  /** The on-screen session's pages and plans, for the collapsed panel's small indicator. */
  pages: number
  plans: number
  setPreferred: (preferred: boolean) => void
  setAvailable: (pages: number, plans: number) => void
}

export const useSessionWorkView = create<SessionWorkViewState>((set) => ({
  preferred: readPreferred(),
  pages: 0,
  plans: 0,
  setPreferred: (preferred) => {
    writePreferred(preferred)
    set((current) => (current.preferred === preferred ? current : { preferred }))
  },
  setAvailable: (pages, plans) =>
    set((current) =>
      current.pages === pages && current.plans === plans ? current : { pages, plans }
    )
}))

/** Titlebar width the collapsed indicator takes, so the tab strip never slides under it. */
export const SESSION_WORK_INDICATOR_RESERVE_PX = 124

export function useSessionWorkIndicatorReserve(): number {
  return useSessionWorkView((s) =>
    s.pages > 0 || s.plans > 0 ? SESSION_WORK_INDICATOR_RESERVE_PX : 0
  )
}
