import {
  readNativeChatPlan,
  readNativeChatToolPlan,
  type NativeChatPlan
} from '../../../../shared/native-chat-plan'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Read the latest snapshot, including an empty snapshot that clears the plan. */
export function selectLatestNativeChatPlan(
  messages: readonly NativeChatMessage[]
): NativeChatPlan | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message.role === 'user') {
      continue
    }
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex]
      const plan =
        block.type === 'text'
          ? readNativeChatPlan(block.plan)
          : block.type === 'tool-call' && block.state !== 'failed'
            ? readNativeChatToolPlan(block.name, block.input)
            : null
      if (plan) {
        return plan
      }
    }
  }
  return null
}

export function summarizeNativeChatPlan(plan: NativeChatPlan) {
  return {
    completed: plan.entries.filter((entry) => entry.status === 'completed').length,
    total: plan.entries.length,
    current: plan.entries.find((entry) => entry.status === 'in_progress') ?? null,
    next: plan.entries.find((entry) => entry.status === 'pending') ?? null
  }
}

export function nativeChatPlanEntryRows(plan: NativeChatPlan) {
  const occurrences = new Map<string, number>()
  return plan.entries.map((entry) => {
    const occurrence = occurrences.get(entry.content) ?? 0
    occurrences.set(entry.content, occurrence + 1)
    return { key: JSON.stringify([entry.content, occurrence]), entry }
  })
}
