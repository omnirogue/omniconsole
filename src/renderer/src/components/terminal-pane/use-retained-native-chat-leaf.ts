import { useLayoutEffect, useRef } from 'react'

/** A view toggle must not dispose the composer that owns an accepted send. */
export function useRetainedNativeChatLeaf(
  tabId: string,
  isChatViewMode: boolean,
  chatLeafId: string | null,
  activeLeafId: string | null
): string | null {
  const retained = useRef<{ tabId: string; leafId: string } | null>(null)
  useLayoutEffect(() => {
    if (isChatViewMode && chatLeafId) {
      retained.current = { tabId, leafId: chatLeafId }
    }
  }, [tabId, isChatViewMode, chatLeafId])
  if (isChatViewMode && chatLeafId) {
    return chatLeafId
  }
  const retainedLeafId = retained.current?.tabId === tabId ? retained.current.leafId : null
  // The route effect restores chatLeafId after reveal; keep the same pane through that commit.
  return !isChatViewMode || retainedLeafId === activeLeafId ? retainedLeafId : null
}
