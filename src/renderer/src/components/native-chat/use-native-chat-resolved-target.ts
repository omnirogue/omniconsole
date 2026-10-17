import { useCallback } from 'react'
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

/** Resolve the live ptyId for a chat leaf; runtime owner settings route local vs remote (SSH) sends. */
export function useNativeChatResolvedTarget(
  targetPtyId: string | null | undefined,
  terminalTabId: string
): () => NativeChatResolvedTarget | null {
  return useCallback((): NativeChatResolvedTarget | null => {
    if (!targetPtyId) {
      return null
    }
    return { ptyId: targetPtyId, settings: getSettingsForAgentTabRuntimeOwner(terminalTabId) }
  }, [targetPtyId, terminalTabId])
}
