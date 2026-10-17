import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { parsedNextStepSuggestionsFromText } from '../../../../shared/native-chat-next-action'
import type {
  NextStepSuggestion,
  NextStepSuggestionSet
} from '../../../../shared/next-step-suggestions'
import type { NextStepsCurrentResult } from '../../../../shared/next-step-suggestions-rpc'

/** The agent's latest reply, while no later message from the person has answered it. */
export type NextStepsReply = {
  messageId: string
  timestamp: number | null
  /** The steps the reply itself proposes, with ids short enough for the host (`s1`, `s2`, …). */
  suggestions: NextStepSuggestion[]
}

export function latestNextStepsReply(
  messages: readonly NativeChatMessage[]
): NextStepsReply | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user') {
      return null
    }
    if (message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .filter((block) => block.type === 'text' && !block.providerFrame)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
    if (text.trim()) {
      return {
        messageId: message.id,
        timestamp: message.timestamp,
        suggestions: parsedNextStepSuggestionsFromText(text, message.id).map((step, at) => ({
          ...step,
          id: `s${at + 1}`
        }))
      }
    }
  }
  return null
}

export type NextStepsTrayView = {
  /** The rows on offer and the set every decision about them goes to. */
  shown: { set: NextStepSuggestionSet; suggestions: NextStepSuggestion[] } | null
  /** The AI's steps offered beside the reply's own, after the person asked for more. */
  extra: { set: NextStepSuggestionSet; suggestions: NextStepSuggestion[] } | null
  thinking: boolean
  failure: string | null
  /** This turn was answered; nothing more is offered for it. */
  answered: boolean
}

/** A reply is written before its turn's completion is stamped; this allows for clock jitter. */
export const NEXT_STEPS_STALE_SLACK_MS = 2_000

const ANSWERED = new Set<NextStepSuggestionSet['status']>(['accepted', 'dismissed'])
const NOTHING: NextStepsTrayView = {
  shown: null,
  extra: null,
  thinking: false,
  failure: null,
  answered: false
}

/**
 * What the tray offers for the host's current turn. The reply's own steps lead; an AI set shows
 * in their place only when the reply proposed none, and beside them (`extra`) when the person
 * asked for more. `reply` is undefined on a surface with no transcript (the Terminal view).
 */
export function resolveNextStepsTrayView(
  current: NextStepsCurrentResult | null,
  reply: NextStepsReply | undefined
): NextStepsTrayView {
  if (!current?.turnKey) {
    return NOTHING
  }
  const { ai } = current
  // The host reads a reply's steps itself; a set offered by a client names its reply.
  const parsed =
    current.parsed &&
    (reply === undefined ||
      current.parsed.messageId === undefined ||
      current.parsed.messageId === reply.messageId)
      ? current.parsed
      : undefined
  if (
    current.answered ||
    (ai && ANSWERED.has(ai.status)) ||
    (parsed && ANSWERED.has(parsed.status))
  ) {
    return { ...NOTHING, answered: true }
  }
  // The host is behind this transcript: the reply on screen is newer than its current turn.
  if (
    reply?.timestamp != null &&
    current.turnCompletedAt !== undefined &&
    reply.timestamp > current.turnCompletedAt + NEXT_STEPS_STALE_SLACK_MS
  ) {
    return NOTHING
  }
  const ready = ai?.status === 'pending' && ai.suggestions.length ? ai : undefined
  if (parsed?.status === 'pending' && parsed.suggestions.length) {
    return {
      shown: { set: parsed, suggestions: parsed.suggestions },
      extra: ready ? { set: ready, suggestions: ready.suggestions } : null,
      thinking: ai?.status === 'generating',
      failure: ai?.status === 'failed' ? (ai.error?.trim() ?? '') : null,
      answered: false
    }
  }
  if (ready) {
    return { ...NOTHING, shown: { set: ready, suggestions: ready.suggestions } }
  }
  return {
    shown: null,
    extra: null,
    thinking: ai?.status === 'generating',
    // An empty reason is shown as a default by the failure line, never as blank text.
    failure: ai?.status === 'failed' ? (ai.error?.trim() ?? '') : null,
    answered: false
  }
}
