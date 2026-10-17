import { useMemo } from 'react'
import {
  commandMarkersAsMessages,
  type NativeChatCommandMarker
} from './native-chat-command-marker'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat-streaming'

/**
 * The pending-augmented view of a session: the settled transcript plus the command
 * markers, the streaming preview and the queued sends, in the order they are read.
 *
 * Split out of NativeChatResolvedView so the component stays under its line ceiling.
 * Both derivations are pure, so they move together and the component keeps only the
 * one value it renders from.
 */
export function useNativeChatSessionWithPending<
  Session extends { messages: Message[] },
  Message
>(input: {
  base: Session
  pending: unknown[]
  pendingMessages: Message[]
  commandMarkers: NativeChatCommandMarker[]
  previewText: string | null | undefined
  working: boolean
  previewIsToolOutput: boolean
}): { streamingText: string | null; sessionWithPending: Session } {
  const { base, pending, pendingMessages, commandMarkers, previewText, working } = input
  const previewIsToolOutput = input.previewIsToolOutput
  const streamingText = useMemo(() => {
    return deriveNativeChatStreamingText({
      messages: (pendingMessages.length > 0
        ? [...base.messages, ...pendingMessages]
        : base.messages) as never,
      previewText,
      working,
      previewIsToolOutput
    })
  }, [base.messages, pendingMessages, previewText, working, previewIsToolOutput])
  const sessionWithPending = useMemo<Session>(() => {
    if (pending.length === 0 && commandMarkers.length === 0 && !streamingText) {
      return base
    }
    return {
      ...base,
      messages: [
        ...base.messages,
        ...(commandMarkersAsMessages(commandMarkers) as Message[]),
        ...(streamingText ? [nativeChatStreamingMessage(streamingText) as Message] : []),
        ...pendingMessages
      ]
    }
  }, [base, pending, pendingMessages, commandMarkers, streamingText])
  return { streamingText, sessionWithPending }
}
