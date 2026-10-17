/**
 * "Improve this": the agent's latest reply, opened in the Improve workflow to be made better.
 * Improve takes only a task, so the reply goes into it as the version to improve, after the
 * conversation's goal (the person's first message), which Improve's judges also read.
 */

import type { NativeChatMessage } from '../../../../shared/native-chat-types'

export const IMPROVE_THIS_MAX_CHARS = 20_000

export type ImproveThisSeed = { goal: string; reply: string }

function messageText(message: NativeChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text' && !block.providerFrame)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

/** The latest reply (only when no person message follows it) and the goal; null without one. */
export function improveThisSeed(messages: readonly NativeChatMessage[]): ImproveThisSeed | null {
  let reply = ''
  for (let index = messages.length - 1; index >= 0 && !reply; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      return null
    }
    if (message.role === 'assistant') {
      reply = messageText(message)
    }
  }
  if (!reply) {
    return null
  }
  const first = messages.find((message) => message.role === 'user' && messageText(message))
  return {
    goal: (first ? messageText(first) : '').slice(0, IMPROVE_THIS_MAX_CHARS),
    reply: reply.slice(0, IMPROVE_THIS_MAX_CHARS)
  }
}

export function improveThisPrompt(seed: ImproveThisSeed): string {
  const ask = `Make this better. It is the agent's latest reply in the conversation:\n\n${seed.reply}`
  return seed.goal ? `${seed.goal}\n\n${ask}` : ask
}
