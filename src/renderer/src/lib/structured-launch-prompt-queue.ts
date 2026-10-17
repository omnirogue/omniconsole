import { createStructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'
import {
  readOutbox,
  writeOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'

/**
 * Queue a launch prompt as the session's first outbox message. The structured
 * chat drains its outbox once it attaches, with the same idempotent send path a
 * typed message uses, so a prompt given at launch is one accepted turn — never
 * a keystroke into a startup menu.
 */
export function queueStructuredLaunchPrompt(sessionId: string, prompt: string): boolean {
  const text = prompt.trim()
  if (!text) {
    return false
  }
  const existing = readOutbox(sessionId)
  if (
    existing.some((entry) =>
      entry.body.blocks.some((block) => block.type === 'text' && block.text === text)
    )
  ) {
    return true
  }
  return writeOutbox(sessionId, [
    ...existing,
    createStructuredAgentSessionOutboxEntry({
      clientMessageId: `launch_${crypto.randomUUID().replaceAll('-', '')}`,
      sessionId,
      text,
      attachments: [],
      queuedAt: Date.now()
    })
  ])
}
