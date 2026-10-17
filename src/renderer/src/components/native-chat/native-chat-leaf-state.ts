import { useCallback } from 'react'
import { create } from 'zustand'

type NativeChatLeafState = {
  nativeChatLeafByTabId: Record<string, string | null>
}

export const useNativeChatLeafState = create<NativeChatLeafState>(() => ({
  nativeChatLeafByTabId: {}
}))

export function setNativeChatLeaf(tabId: string, leafId: string | null): void {
  useNativeChatLeafState.setState((state) =>
    state.nativeChatLeafByTabId[tabId] === leafId
      ? state
      : { nativeChatLeafByTabId: { ...state.nativeChatLeafByTabId, [tabId]: leafId } }
  )
}

export function useNativeChatLeaf(tabId: string) {
  const leafId = useNativeChatLeafState((state) => state.nativeChatLeafByTabId[tabId] ?? null)
  const setLeafId = useCallback((leaf: string | null) => setNativeChatLeaf(tabId, leaf), [tabId])
  return [leafId, setLeafId] as const
}

export function forgetNativeChatLeaf(tabIds: Iterable<string>): void {
  useNativeChatLeafState.setState((state) => {
    let next = state.nativeChatLeafByTabId
    for (const tabId of tabIds) {
      if (!Object.hasOwn(next, tabId)) {
        continue
      }
      if (next === state.nativeChatLeafByTabId) {
        next = { ...next }
      }
      delete next[tabId]
    }
    return next === state.nativeChatLeafByTabId ? state : { nativeChatLeafByTabId: next }
  })
}
