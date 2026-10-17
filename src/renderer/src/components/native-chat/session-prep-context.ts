import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  formatSessionPrepEntry,
  takeNewestFitting,
  type SessionPrepContextLabel
} from '../../../../shared/session-prep-context-format'
import { SESSION_PREP_MAX_CONTEXT_CHARS } from '../../../../shared/session-prep-types'

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

function entryLabel(role: NativeChatMessage['role']): SessionPrepContextLabel | null {
  if (role === 'user') {
    return 'User'
  }
  if (role === 'assistant') {
    return 'Assistant'
  }
  return null
}

/** Conversation excerpt for session prep: user/assistant text, newest kept last. */
export function sessionPrepConversationContext(
  messages: NativeChatMessage[],
  max = SESSION_PREP_MAX_CONTEXT_CHARS
): string {
  const entries: string[] = []
  for (const message of messages) {
    const label = entryLabel(message.role)
    const entry = label ? formatSessionPrepEntry(label, messageText(message)) : null
    if (entry) {
      entries.push(entry)
    }
  }
  return takeNewestFitting(entries, max)
}
