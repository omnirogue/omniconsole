import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { notePersonTypingInConversation } from '../next-steps/next-steps-person-typing'
import type { HistoryState } from './native-chat-composer-state'

/** The composer field's caret sync and change handler: draft, history, caret and picker follow. */
export function useNativeChatDraftChange({
  paneKey,
  setDraft,
  setHistory,
  setCaret,
  setActiveSuggestion,
  handleDraftOrCaretChange
}: {
  paneKey: string
  setDraft: (next: string) => void
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setCaret: (caret: number) => void
  setActiveSuggestion: (index: number) => void
  handleDraftOrCaretChange: (value: string, caret: number) => void
}) {
  const syncCaret = useCallback(
    (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length),
    [setCaret]
  )
  const handleDraftChange = useCallback(
    (value: string, element: HTMLTextAreaElement) => {
      // Typing in the composer, sent or not, takes the conversation back from Keep going.
      notePersonTypingInConversation(paneKey)
      setDraft(value)
      setHistory((prev) => ({ entries: prev.entries, index: null }))
      syncCaret(element)
      handleDraftOrCaretChange(value, element.selectionStart ?? value.length)
      setActiveSuggestion(0)
    },
    [handleDraftOrCaretChange, paneKey, setActiveSuggestion, setDraft, setHistory, syncCaret]
  )
  return { syncCaret, handleDraftChange }
}
