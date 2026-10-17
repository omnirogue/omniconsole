import { useMemo } from 'react'
import { NativeChatMessageList } from '@/components/native-chat/NativeChatMessageList'
import type { NativeChatLiveSession } from '@/components/native-chat/use-native-chat-live-session'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { RoomEvent } from '../../../../shared/rooms'

export function roomEventMessage(event: RoomEvent, currentUserId: string): NativeChatMessage {
  const sender = event.senderName.replace(/\s+/g, ' ').replace(/[\\`*_{}[\]()<>#+.!|~-]/g, '\\$&')
  const activity = event.eventKind === 'activity'
  return {
    id: event.eventId,
    role:
      activity || event.senderKind === 'system' || event.eventKind === 'system'
        ? 'system'
        : event.senderId === currentUserId
          ? 'user'
          : 'assistant',
    timestamp: Date.parse(event.createdAt),
    source: 'transcript',
    blocks: activity
      ? [
          { type: 'text', text: sender },
          {
            type: 'tool-call',
            name: event.metadata?.toolName ?? event.metadata?.kind ?? 'activity',
            input: {}
          },
          { type: 'tool-result', output: event.content }
        ]
      : [{ type: 'text', text: `**${sender}**\n\n${event.content}` }]
  }
}
export function RoomThread({
  events,
  currentUserId
}: {
  events: RoomEvent[]
  currentUserId: string
}): React.JSX.Element {
  const session = useMemo<NativeChatLiveSession>(
    () => ({
      messages: events.map((event) => roomEventMessage(event, currentUserId)),
      status: 'ready',
      sessionId: null,
      agent: 'unknown',
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: () => undefined,
      readPhase: 'ready'
    }),
    [events, currentUserId]
  )
  return (
    <NativeChatMessageList
      session={session}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
      preserveMessageOrder
    />
  )
}
