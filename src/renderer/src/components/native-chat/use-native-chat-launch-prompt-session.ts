// The transcript the resolved view actually renders: the live session plus the
// pane's undelivered launch prompt, then trimmed at any /clear boundary.
//
// Lifted out of NativeChatResolvedView so that file stays inside its line
// budget; the memo chain and its dependencies are unchanged.

import { useMemo } from 'react'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { NativeChatCommandMarker } from './native-chat-command-marker'
import { applyCommandMarkerBoundaries } from './native-chat-command-marker'
import { launchPromptAsMessage } from './native-chat-pending'
import type { NativeChatLiveSession } from './native-chat-live-session-types'

export function useNativeChatLaunchPromptSession({
  session,
  paneLaunchPrompt,
  commandMarkers
}: {
  session: NativeChatLiveSession
  paneLaunchPrompt: NativeChatLaunchPrompt | null
  commandMarkers: readonly NativeChatCommandMarker[]
}): {
  sessionAfterCommandBoundaries: NativeChatLiveSession
  failedLaunchPromptMessageIds: ReadonlySet<string> | undefined
} {
  const launchPromptMessage = useMemo(
    () => launchPromptAsMessage(paneLaunchPrompt, session.messages),
    [paneLaunchPrompt, session.messages]
  )
  const sessionWithLaunchPrompt = useMemo<NativeChatLiveSession>(() => {
    if (!launchPromptMessage) {
      return session
    }
    return { ...session, messages: [...session.messages, launchPromptMessage] }
  }, [launchPromptMessage, session])

  const sessionAfterCommandBoundaries = useMemo<NativeChatLiveSession>(() => {
    const messages = applyCommandMarkerBoundaries(sessionWithLaunchPrompt.messages, commandMarkers)
    return messages === sessionWithLaunchPrompt.messages
      ? sessionWithLaunchPrompt
      : { ...sessionWithLaunchPrompt, messages }
  }, [sessionWithLaunchPrompt, commandMarkers])

  const failedLaunchPromptMessageIds = useMemo(() => {
    const id = paneLaunchPrompt?.failed ? launchPromptMessage?.id : null
    if (!id || !sessionAfterCommandBoundaries.messages.some((message) => message.id === id)) {
      return undefined
    }
    return new Set([id])
  }, [paneLaunchPrompt?.failed, launchPromptMessage?.id, sessionAfterCommandBoundaries.messages])

  return { sessionAfterCommandBoundaries, failedLaunchPromptMessageIds }
}
