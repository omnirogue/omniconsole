import { fallbackConversationTitle, isPlaceholderConversationTitle } from '@/lib/conversation-state'
import type { AgentType } from '../../../../shared/agent-status-types'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
import { translate } from '@/i18n/i18n'
import type { AttentionCause } from './agent-pane-snapshot'

export function attentionCauseLabel(cause: AttentionCause): string {
  return cause === 'blocked'
    ? translate('auto.components.attention.AttentionPage.blocked', 'Blocked on a decision')
    : translate('auto.components.attention.AttentionPage.waiting', 'Waiting for your input')
}

type AskQuestion = { question?: unknown; header?: unknown }

/** Pull the first question out of an AskUserQuestion payload; null when the summary is not that shape. */
export function describeAttentionAsk(askSummary: string | undefined): string | null {
  if (!askSummary) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(askSummary)
  } catch {
    return askSummary.trim() || null
  }
  if (typeof parsed === 'string') {
    return parsed.trim() || null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const record = parsed as { questions?: unknown; question?: unknown }
  const candidates: AskQuestion[] = Array.isArray(record.questions)
    ? (record.questions as AskQuestion[])
    : [record]
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof candidate.question === 'string') {
      const text = candidate.question.trim()
      if (text) {
        return text
      }
    }
  }
  return null
}

export function attentionPaneTitle(pane: {
  title: string
  worktreeName: string
  agentType?: AgentType
}): string {
  // Why: "Terminal 3" says nothing; the conversation is named by what it is about, else by its agent.
  if (isPlaceholderConversationTitle(pane.title)) {
    return pane.agentType
      ? fallbackConversationTitle(formatAgentTypeLabel(pane.agentType))
      : pane.worktreeName
  }
  return pane.title.trim()
}
