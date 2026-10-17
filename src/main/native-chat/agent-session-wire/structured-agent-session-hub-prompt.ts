import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { prependHubTaskPrompt } from '../../../shared/omnios-task-binding'

export function hubBoundAgentSessionSubmission(input: {
  body: AgentJournalMessageItem
  hubTaskId?: string
  clientMessageId: string
  submissions: readonly AgentJournalSubmission[]
}): AgentJournalMessageItem {
  if (!input.hubTaskId || input.body.role !== 'user') {
    return input.body
  }
  const first = input.submissions[0]
  if (first && first.clientMessageId !== input.clientMessageId) {
    return input.body
  }
  const [head, ...rest] = input.body.blocks
  const prefix = prependHubTaskPrompt('', input.hubTaskId)
  if (head?.type === 'text' && head.text.startsWith(prefix)) {
    return input.body
  }
  return {
    ...input.body,
    blocks:
      head?.type === 'text'
        ? [{ ...head, text: prependHubTaskPrompt(head.text, input.hubTaskId) }, ...rest]
        : [{ type: 'text', text: prefix.trimEnd() }, ...input.body.blocks]
  }
}
