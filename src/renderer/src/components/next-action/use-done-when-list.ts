import { create } from 'zustand'

type DoneWhenListState = {
  /** The conversation whose checklist is open; one at a time, like the mockup's ▾. */
  openChainId: string | null
  open: (chainId: string) => void
  close: () => void
  toggle: (chainId: string) => void
}

/**
 * Which Done When checklist is open. It lives outside the components on purpose: the Outcome head's
 * ▾ and a Verify row's output link are two ways into the SAME list, so neither owns the state.
 */
export const useDoneWhenListStore = create<DoneWhenListState>((set, get) => ({
  openChainId: null,
  open: (chainId) => set({ openChainId: chainId }),
  close: () => set({ openChainId: null }),
  toggle: (chainId) => set({ openChainId: get().openChainId === chainId ? null : chainId })
}))

export type DoneWhenListController = {
  expanded: boolean
  open: () => void
  close: () => void
  toggle: () => void
}

/**
 * The controller for one conversation's checklist. Without a chain nothing can be opened, so the
 * hook still returns a controller — it simply reports collapsed and does nothing.
 */
export function useDoneWhenList(chainId: string | null | undefined): DoneWhenListController {
  const openChainId = useDoneWhenListStore((state) => state.openChainId)
  const store = useDoneWhenListStore
  return {
    expanded: Boolean(chainId) && openChainId === chainId,
    open: () => {
      if (chainId) {
        store.getState().open(chainId)
      }
    },
    close: () => store.getState().close(),
    toggle: () => {
      if (chainId) {
        store.getState().toggle(chainId)
      }
    }
  }
}

/** For a surface outside React's tree (a row action, a command): open the same list. */
export function openDoneWhenList(chainId: string): void {
  useDoneWhenListStore.getState().open(chainId)
}
