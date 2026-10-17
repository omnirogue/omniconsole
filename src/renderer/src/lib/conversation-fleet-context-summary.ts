import type { NativeChatMessage } from '../../../shared/native-chat-types'

/** Reuse a captured response; raw records and tool output cannot establish an assistant summary. */
export function readCapturedAssistantSummary(
  messages: readonly NativeChatMessage[]
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .flatMap((block) => (block.type === 'text' && !block.providerFrame ? [block.text] : []))
      .join('\n')
    if (text.trim()) {
      return text
    }
  }
  return undefined
}
