import type {
  AgentJournalPromptOption,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import {
  describeSessionPrompt,
  persistentApproval,
  promptHasControlCharacters,
  promptTextIncomplete,
  STRUCTURED_ALLOW_ONCE_IDS,
  STRUCTURED_DENY_IDS,
  type SessionPrompt,
  type SessionPromptOption
} from './session-prompt'
import { literalPromptCommand, structuredPromptCommand } from './session-prompt-command'

function sameOptions(
  a: readonly AgentJournalPromptOption[],
  b: readonly AgentJournalPromptOption[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (option, index) =>
        option.id === b[index]!.id &&
        option.label === b[index]!.label &&
        (option.description ?? '') === (b[index]!.description ?? '')
    )
  )
}

/**
 * The one question this item asks, from its full question record: exactly one, single-choice, and
 * saying the same question, options and free-text address as the item itself. A missing record
 * (Codex items carry none), a grouped or multi-select one, or any mismatch refuses: the item's own
 * fields could then be a summary of something else.
 */
function singleQuestion(body: AgentJournalQuestionItem): string | null {
  const [question, ...rest] = Array.isArray(body.questions) ? body.questions : []
  if (
    !question ||
    rest.length > 0 ||
    question.multiSelect !== false ||
    question.question !== body.question ||
    (question.freeTextQuestionId ?? null) !== (body.freeTextQuestionId ?? null) ||
    !Array.isArray(question.options) ||
    !sameOptions(question.options, body.options)
  ) {
    return null
  }
  return question.header ?? ''
}

export function readStructuredSessionPrompt(
  sessionId: string,
  pending: { fence: number; items: readonly AgentJournalRenderItem[] }
): SessionPrompt | null {
  if (pending.items.length !== 1) {
    return null
  }
  const item = pending.items[0]!
  const body = item.body
  if (
    (body.kind !== 'approval' && body.kind !== 'question') ||
    body.resolution.state !== 'pending' ||
    !Array.isArray(body.options) ||
    body.options.length === 0
  ) {
    return null
  }
  const header = body.kind === 'question' ? singleQuestion(body) : ''
  if (header === null) {
    return null
  }
  const text =
    body.kind === 'approval' ? [body.title, body.detail].filter(Boolean).join('\n') : body.question
  if (typeof text !== 'string' || !text.trim()) {
    return null
  }
  // The same gate as a screen: control characters anywhere shown, hashed or sent refuse it.
  if (
    [
      text,
      header,
      body.kind === 'approval' ? (body.command ?? '') : '',
      body.kind === 'question' ? (body.freeTextQuestionId ?? '') : '',
      ...body.options.flatMap((option) => [option.id, option.label, option.description ?? ''])
    ].some(promptHasControlCharacters)
  ) {
    return null
  }
  const options: SessionPromptOption[] = body.options.map((option, index) => ({
    n: index + 1,
    label: [option.label, option.description].filter(Boolean).join(' — '),
    value: option.id,
    ...(body.kind === 'approval' &&
    !persistentApproval(`${option.id} ${option.label} ${option.description ?? ''}`)
      ? STRUCTURED_ALLOW_ONCE_IDS.has(option.id)
        ? { role: 'allow-once' as const }
        : STRUCTURED_DENY_IDS.has(option.id)
          ? { role: 'deny' as const }
          : {}
      : {})
  }))
  const decoded =
    body.kind === 'approval' ? structuredPromptCommand(body.title, body.detail, body.command) : null
  const literal = decoded === null ? null : literalPromptCommand(decoded)
  const commandText =
    body.kind === 'approval'
      ? [body.detail, decoded, literal].filter((value): value is string => value !== null)
      : header
        ? [header]
        : []
  const readable =
    !promptTextIncomplete(text) &&
    (!header || !promptTextIncomplete(header)) &&
    (body.kind !== 'approval' || literal !== null)
  const kind = body.kind === 'approval' ? 'permission' : 'question'
  return {
    ask: describeSessionPrompt(kind, text, options, readable, commandText),
    options,
    readable,
    subject: text,
    commandText,
    delivery: {
      kind: 'structured',
      sessionId,
      fence: pending.fence,
      itemId: item.itemId,
      revision: item.revision,
      ...(body.kind === 'question' && body.freeTextQuestionId
        ? { freeTextQuestionId: body.freeTextQuestionId }
        : {})
    }
  }
}
