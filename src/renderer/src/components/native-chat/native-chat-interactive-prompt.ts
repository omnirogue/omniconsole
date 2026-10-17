import { translate } from '@/i18n/i18n'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  formatAsyncAskAnswer,
  hasAskAnswer,
  parseAskFromStatus,
  registerQuestionTool,
  type AskAnswerKeyGroup,
  type AskAnswerSelection,
  type AskOption,
  type AskPrompt,
  type AskQuestion,
  type InteractiveQuestionParser
} from '../../../../shared/native-chat-ask'

export {
  buildAskAnswerKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  formatAsyncAskAnswer,
  hasAskAnswer,
  parseAskFromStatus,
  registerQuestionTool,
  type AskAnswerKeyGroup,
  type AskAnswerSelection,
  type AskOption,
  type AskPrompt,
  type AskQuestion,
  type InteractiveQuestionParser
}

export type ChatApproval = {
  title: string
  detail?: string
  protocol?: 'omp-selector-v1'
  requestId?: string
  options: { label: string; send: string }[]
}

export type InteractivePromptCard =
  | { kind: 'question'; prompt: AskPrompt }
  | { kind: 'approval'; approval: ChatApproval }
  | null

const ESCAPE = String.fromCharCode(27)

/** Parse the desktop-only approval envelope; question parsing stays cross-platform. */
export function parseApprovalFromStatus(
  interactivePrompt: string | undefined | null
): ChatApproval | null {
  if (!interactivePrompt) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(interactivePrompt)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const isOmp = 'ompApproval' in parsed
  const approval = isOmp
    ? (parsed as { ompApproval?: unknown }).ompApproval
    : (parsed as { approval?: unknown }).approval
  if (!approval || typeof approval !== 'object') {
    return null
  }
  const tool = (approval as { tool?: unknown }).tool
  if (typeof tool !== 'string' || tool.length === 0) {
    return null
  }
  const summary = (approval as { summary?: unknown }).summary
  const toolCallId = (approval as { toolCallId?: unknown }).toolCallId
  if (isOmp && (typeof toolCallId !== 'string' || !toolCallId.trim())) {
    return null
  }
  return {
    ...(isOmp ? { protocol: 'omp-selector-v1' as const, requestId: toolCallId as string } : {}),
    title: translate('components.native-chat.approval.title', 'Allow {{value0}}?', {
      value0: tool
    }),
    detail: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
    options: [
      {
        label: translate('components.native-chat.approval.allow', 'Allow'),
        send: isOmp ? 'approve' : '1'
      },
      {
        label: translate('components.native-chat.approval.deny', 'Deny'),
        send: isOmp ? 'deny' : ESCAPE
      }
    ]
  }
}

export function buildNativeChatApprovalKeys(
  approval: ChatApproval,
  choice: string,
  agent: AgentType
): readonly string[] {
  if (approval.protocol === 'omp-selector-v1') {
    if (agent !== 'omp') {
      return []
    }
    // OMP clamps its two-row selector; Up always reaches Approve, then Enter commits.
    return choice === 'approve' ? ['\x1b[A', '\r'] : choice === 'deny' ? [ESCAPE] : []
  }
  return agent !== 'omp' && (choice === '1' || choice === ESCAPE) ? [choice] : []
}

export function parseInteractivePrompt(
  interactivePrompt: string | undefined | null,
  toolName?: string
): InteractivePromptCard {
  const prompt = parseAskFromStatus(interactivePrompt, toolName)
  if (prompt) {
    return { kind: 'question', prompt }
  }
  const approval = parseApprovalFromStatus(interactivePrompt)
  return approval ? { kind: 'approval', approval } : null
}
