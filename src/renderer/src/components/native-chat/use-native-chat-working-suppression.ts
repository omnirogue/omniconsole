import { useEffect, useRef } from 'react'
import {
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'

export function useNativeChatWorkingSuppression({
  working,
  interrupted,
  workingEpoch,
  isConversation,
  stopPending,
  setInterrupted
}: {
  working: boolean
  interrupted: boolean
  workingEpoch: number | null
  isConversation: boolean
  stopPending: boolean
  setInterrupted: (value: boolean) => void
}): boolean {
  const previousWorkingEpoch = useRef<number | null>(null)
  useEffect(() => {
    if (
      shouldClearNativeChatWorkingSuppression({
        working,
        interrupted,
        workingEpoch,
        previousWorkingEpoch: previousWorkingEpoch.current
      })
    ) {
      setInterrupted(false)
    }
    if (working && workingEpoch != null) {
      previousWorkingEpoch.current = workingEpoch
    }
    if (!working) {
      previousWorkingEpoch.current = null
    }
  }, [working, interrupted, workingEpoch, setInterrupted])
  return stopPending || shouldShowNativeChatWorking({ isConversation, working, interrupted })
}
