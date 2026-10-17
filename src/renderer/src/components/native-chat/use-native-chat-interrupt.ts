import { useCallback } from 'react'
import { sendRuntimePtyInput } from '@/runtime/runtime-terminal-inspection'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

// Use the existing PTY interrupt path so native input observers retain execution ownership.
const ESC = '\x1b'

/**
 * Esc: drop what has not left yet, stop the turn if one is running, and otherwise interrupt the
 * agent the way a keystroke would. Nothing here decides what was sent — it only stops it.
 */
export function useNativeChatInterrupt({
  cancelPendingSends,
  isWorking,
  onStop,
  resolveTarget
}: {
  cancelPendingSends: () => void
  isWorking: boolean
  onStop?: () => void
  resolveTarget: () => NativeChatResolvedTarget | null
}): () => void {
  return useCallback(() => {
    cancelPendingSends()
    if (isWorking && onStop) {
      onStop()
      return
    }
    const target = resolveTarget()
    if (!target) {
      return
    }
    sendRuntimePtyInput(target.settings, target.ptyId, ESC)
  }, [cancelPendingSends, isWorking, onStop, resolveTarget])
}
