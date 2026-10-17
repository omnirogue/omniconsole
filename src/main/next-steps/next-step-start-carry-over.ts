/**
 * Carry-over for suggested starts: steps a workspace's last FINISHED conversation was offered and
 * never answered, plus what the previous start set carried and nobody used. Free and instant.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import {
  NEXT_STEP_SUGGESTION_MAX,
  NEXT_STEP_TITLE_MAX,
  nextStepRiskOf,
  type NextStepSuggestion,
  type NextStepSuggestionSet
} from '../../shared/next-step-suggestions'
import type { NextStepSuggestionService } from './next-step-suggestion-service'

export const NEXT_STEP_CARRIED_REASON = 'Carried to a new session.'

const CARRIED_ID = /^c\d+$/
const OPEN_START = new Set<NextStepSuggestionSet['status']>(['generating', 'pending', 'failed'])

/**
 * Whether a conversation may still answer its own set. Absent or unsure = live: a set is never
 * taken from a conversation that could still run it.
 */
export type NextStepConversationLiveness = (conversation: ConversationSource) => boolean

/**
 * The set a new session carries over: the newest unanswered set of the workspace's most recent
 * conversation that is no longer live, the reply's own steps before the AI's.
 */
export function carryOverSource(
  sets: readonly NextStepSuggestionSet[],
  worktreeId: string,
  isLive: NextStepConversationLiveness | undefined
): NextStepSuggestionSet | null {
  if (!isLive) {
    return null
  }
  const offered = sets
    .filter(
      (set) =>
        set.worktreeId === worktreeId &&
        set.conversation !== undefined &&
        set.origin !== 'start' &&
        set.status === 'pending' &&
        set.suggestions.length > 0 &&
        !isLive(set.conversation)
    )
    .toSorted((left, right) => right.createdAt - left.createdAt)
  const newest = offered[0]
  if (!newest?.conversation) {
    return null
  }
  const key = conversationSourceRowKey(newest.conversation)
  return (
    offered.find(
      (set) =>
        set.origin === 'parsed' &&
        set.conversation &&
        conversationSourceRowKey(set.conversation) === key
    ) ?? newest
  )
}

/** The newest start set of this workspace nobody answered, in any hour. */
export function previousOpenStartSet(
  sets: readonly NextStepSuggestionSet[],
  worktreeId: string
): NextStepSuggestionSet | undefined {
  return sets
    .filter(
      (set) =>
        set.origin === 'start' &&
        set.worktreeId === worktreeId &&
        !set.conversation &&
        OPEN_START.has(set.status)
    )
    .toSorted((left, right) => right.createdAt - left.createdAt)[0]
}

/** The source's steps first, then what the previous start set carried; ids become `c1…`. */
export function collectCarryOver(
  source: NextStepSuggestionSet | null,
  previous: NextStepSuggestionSet | undefined
): NextStepSuggestion[] {
  const inherited = (previous?.suggestions ?? []).filter((step) => CARRIED_ID.test(step.id))
  const seen = new Set<string>()
  const steps: NextStepSuggestion[] = []
  for (const step of [...(source?.suggestions ?? []), ...inherited]) {
    const key = step.title.trim().toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      steps.push(step)
    }
  }
  return steps.slice(0, NEXT_STEP_SUGGESTION_MAX).map((step, index) => ({
    ...step,
    id: `c${index + 1}`,
    // Why one line: a carried title is printed inside the suggester's fence.
    title: step.title.replace(/\s+/g, ' ').trim().slice(0, NEXT_STEP_TITLE_MAX),
    risk: nextStepRiskOf(`${step.title} ${step.prompt} ${step.why ?? ''}`, step.risk)
  }))
}

/** The carried set's turn is settled, so its steps can never run twice. */
export function settleCarriedSource(
  service: NextStepSuggestionService,
  source: NextStepSuggestionSet
): void {
  if (source.conversation) {
    service.supersedeOpenSets(
      conversationSourceRowKey(source.conversation),
      (set) => set.turnKey === source.turnKey,
      NEXT_STEP_CARRIED_REASON
    )
  }
}
