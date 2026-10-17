import type { NativeChatMessage } from './native-chat-types'
import { nextStepChatSubmissionSource } from './next-step-chat-submission'

export function presentNextStepChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  let presented: NativeChatMessage[] | null = null
  for (const [index, message] of messages.entries()) {
    let blocks: NativeChatMessage['blocks'] | null = null
    if (message.role === 'user') {
      for (const [blockIndex, block] of message.blocks.entries()) {
        const source = block.type === 'text' ? nextStepChatSubmissionSource(block.text) : null
        if (source !== null && source !== undefined && block.type === 'text') {
          blocks ??= message.blocks.slice(0, blockIndex)
          blocks.push({ ...block, text: source })
        } else {
          blocks?.push(block)
        }
      }
    }
    if (blocks) {
      presented ??= messages.slice(0, index)
      presented.push({ ...message, blocks })
    } else {
      presented?.push(message)
    }
  }
  return presented ?? messages
}
