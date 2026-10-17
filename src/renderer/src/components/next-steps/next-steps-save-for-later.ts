import { translate } from '@/i18n/i18n'
import { readSessionPlaceChoice } from '@/store/session-place-store'
import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../../shared/conversation-source'
import type { NextStepSuggestion } from '../../../../shared/next-step-suggestions'
import { resolveNextStepCardFiling } from '../next-step/next-step-card-filing'
import { signedInEmployeeId } from '../next-step/next-step-task-create'

const CARD_TITLE_MAX = 160

export type SavedNextStepCard = { suggestionId: string; title: string } & (
  | { ok: true; taskId: string; warning?: string; alreadyFiled?: true }
  | { ok: false; message: string }
)

/** Cards this window already filed, by `setId:suggestionId`, so a retry never files twice. */
const filedCards = new Map<string, string>()
/** Cards a save is filing right now. */
const claimedCards = new Set<string>()

/**
 * Every key a card is known by: its set and step, and the reply it came from (the conversation and
 * the exact prompt), so the same step offered again for the same reply is never filed twice.
 */
function cardKeys(
  input: { conversation: ConversationSource; setId: string },
  suggestion: NextStepSuggestion
): string[] {
  return [
    nextStepCardIdempotencyKey(input.setId, suggestion.id),
    `${conversationSourceRowKey(input.conversation)}|${suggestion.prompt.replace(/\s+/g, ' ').trim()}`
  ]
}

const filedTask = (keys: readonly string[]): string | undefined =>
  keys.map((key) => filedCards.get(key)).find((taskId) => taskId !== undefined)

export function nextStepCardIdempotencyKey(setId: string, suggestionId: string): string {
  return `${setId}:${suggestionId}`
}

/** Test seam: forgets every filed card. */
export function forgetFiledNextStepCards(): void {
  filedCards.clear()
  claimedCards.clear()
}

export type SaveNextStepsResult = { refusal: string } | { cards: SavedNextStepCard[] }

function cardDescription(suggestion: NextStepSuggestion, sessionLabel: string): string {
  return [
    suggestion.prompt.trim(),
    suggestion.why?.trim() ?? '',
    translate('nextSteps.savedFromSession', 'Suggested in the OmniConsole session “{{session}}”.', {
      session: sessionLabel
    })
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
}

/**
 * One Proposed card per chosen suggestion, filed under the conversation's company, department
 * and goal. Filing that cannot be worked out creates nothing: an unfiled card is a stray. The
 * cards are ideas for later, so this conversation is NOT bound to any of them.
 */
export async function saveNextStepsForLater(input: {
  conversation: ConversationSource
  sessionLabel: string
  setId: string
  suggestions: readonly NextStepSuggestion[]
}): Promise<SaveNextStepsResult> {
  // Why claimed before the first await: two overlapping saves must never both file a card.
  const unfiled = input.suggestions.filter((suggestion) => {
    const keys = cardKeys(input, suggestion)
    return !filedTask(keys) && !keys.some((key) => claimedCards.has(key))
  })
  const claimed = unfiled.flatMap((suggestion) => cardKeys(input, suggestion))
  for (const key of claimed) {
    claimedCards.add(key)
  }
  try {
    return await fileNextStepCards(input, unfiled)
  } finally {
    for (const key of claimed) {
      claimedCards.delete(key)
    }
  }
}

async function fileNextStepCards(
  input: Parameters<typeof saveNextStepsForLater>[0],
  unfiled: readonly NextStepSuggestion[]
): Promise<SaveNextStepsResult> {
  const elsewhere = (suggestion: NextStepSuggestion): SavedNextStepCard => {
    const taskId = filedTask(cardKeys(input, suggestion))
    return taskId
      ? {
          suggestionId: suggestion.id,
          title: suggestion.title,
          ok: true,
          taskId,
          alreadyFiled: true
        }
      : {
          suggestionId: suggestion.id,
          title: suggestion.title,
          ok: false,
          message: translate('nextSteps.saveInProgress', 'It is already being saved.')
        }
  }
  if (!unfiled.length) {
    return { cards: input.suggestions.map(elsewhere) }
  }
  const filed = await resolveNextStepCardFiling(
    input.conversation.worktreeId,
    undefined,
    readSessionPlaceChoice(input.conversation.paneKey)
  )
  if ('refusal' in filed) {
    return { refusal: filed.refusal.reason }
  }
  const { companyId, unitId, goalId } = filed.filing
  const ownerEmployeeId = await signedInEmployeeId()
  const cards: SavedNextStepCard[] = []
  for (const suggestion of input.suggestions) {
    if (!unfiled.includes(suggestion)) {
      cards.push(elsewhere(suggestion))
      continue
    }
    const base = { suggestionId: suggestion.id, title: suggestion.title }
    try {
      const created = await window.api.backoffice.createTask({
        title: suggestion.title.slice(0, CARD_TITLE_MAX),
        description: cardDescription(suggestion, input.sessionLabel),
        companyId,
        unitId,
        goalId,
        ...(ownerEmployeeId ? { ownerEmployeeId } : {}),
        proposed: true
      })
      if (created.ok) {
        for (const key of cardKeys(input, suggestion)) {
          filedCards.set(key, created.taskId)
        }
      }
      cards.push(
        created.ok
          ? {
              ...base,
              ok: true,
              taskId: created.taskId,
              ...(created.tagsApplied === false && created.warning
                ? { warning: created.warning }
                : {})
            }
          : { ...base, ok: false, message: created.message }
      )
    } catch (failure) {
      cards.push({
        ...base,
        ok: false,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    }
  }
  return { cards }
}
