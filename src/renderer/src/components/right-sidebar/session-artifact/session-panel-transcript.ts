import { useEffect } from 'react'
import { create } from 'zustand'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'

const EMPTY: readonly NativeChatMessage[] = []
const useTranscripts = create<{ byPane: Record<string, readonly NativeChatMessage[]> }>(() => ({
  byPane: {}
}))

/** Reuse the chat's existing stream; no second transcript reader or persisted conversation copy. */
export function useShareSessionPanelTranscript(
  paneKey: string | null,
  messages?: readonly NativeChatMessage[]
) {
  useEffect(() => {
    if (!paneKey || !messages) {
      return
    }
    useTranscripts.setState((state) => ({ byPane: { ...state.byPane, [paneKey]: messages } }))
    return () => {
      useTranscripts.setState((state) => {
        if (state.byPane[paneKey] !== messages) {
          return state
        }
        const byPane = { ...state.byPane }
        delete byPane[paneKey]
        return { byPane }
      })
    }
  }, [paneKey, messages])
}

export function useSessionPanelTranscript(paneKey: string | null) {
  return useTranscripts((state) => (paneKey ? (state.byPane[paneKey] ?? EMPTY) : EMPTY))
}
