import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { nextStepChatAsked, nextStepChatPointer } from '../../../shared/next-step-chat-hook-reply'

/**
 * A chat-view conversation has no prompt hook, so a wait or next-step message carries the same
 * one-line pointer at `outcome context` the hook gives a terminal agent. The journal keeps the
 * typed words as the source prompt; only what the agent receives gains the pointer.
 */
export function outcomeBoundAgentSessionSubmission(
  body: AgentJournalMessageItem,
  sourcePrompt: string | null
): AgentJournalMessageItem {
  if (!sourcePrompt || body.role !== 'user' || !nextStepChatAsked(sourcePrompt)) {
    return body
  }
  const pointer = nextStepChatPointer(process.platform === 'linux' ? 'omni-ide' : 'omni')
  const [head, ...rest] = body.blocks
  return {
    ...body,
    blocks:
      head?.type === 'text'
        ? [{ ...head, text: `${head.text}\n\n${pointer}` }, ...rest]
        : [...body.blocks, { type: 'text', text: pointer }]
  }
}
