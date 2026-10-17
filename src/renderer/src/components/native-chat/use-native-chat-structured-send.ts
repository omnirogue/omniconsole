import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { emitNativeChatMessageSent } from '@/lib/native-chat-telemetry'
import type { AgentType } from '../../../../shared/agent-status-types'
import { isStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import { dispatchNativeChatStructuredComposerText } from './native-chat-structured-composer-dispatch'

export function useNativeChatStructuredSend(args: {
  agent: AgentType
  /** The live composer text, read only to tell a settled command apart from one the
   *  person kept typing through. Chat-session commands (`/clear`, `/compact`) settle
   *  asynchronously, so clearing unconditionally on acceptance erases a draft written
   *  while the command was still in flight. */
  draft?: string
  structuredTransport?: NativeChatStructuredComposerTransport
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setDraft: (text: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  clearImageAttachments: () => void
}) {
  const composition = useRef({ draft: args.draft, imageAttachments: args.imageAttachments })
  useLayoutEffect(() => {
    composition.current = { draft: args.draft, imageAttachments: args.imageAttachments }
  }, [args.draft, args.imageAttachments])
  return useCallback(
    async (
      text: string,
      attachments = args.imageAttachments,
      // Why: wizard sends deliver a wrapped instruction; recall should return the user's words.
      historyText = text
    ): Promise<boolean> => {
      const transport = args.structuredTransport
      if (!transport) {
        return false
      }
      if (attachments.length > 0 && isStructuredAgentSessionComposerCommand(text, args.agent)) {
        transport.onError('Remove attachments before using a chat-session command.')
        return false
      }
      const submitted = composition.current
      try {
        const { accepted, error } = await dispatchNativeChatStructuredComposerText(
          transport,
          text,
          attachments
        )
        transport.onError(error)
        if (!accepted) {
          return false
        }
        emitNativeChatMessageSent({ agent: args.agent, runtime: transport.runtime })
        args.setHistory((previous) => pushHistory(previous, historyText))
        if (
          isStructuredAgentSessionComposerCommand(text, args.agent) &&
          (composition.current.draft !== submitted.draft ||
            composition.current.imageAttachments !== submitted.imageAttachments)
        ) {
          return true
        }
        args.setDraft('')
        args.setCaret(0)
        args.clearSkillOrigin()
        args.clearImageAttachments()
        return true
      } catch (error) {
        transport.onError(error instanceof Error ? error.message : String(error))
        return false
      }
    },
    [args]
  )
}
