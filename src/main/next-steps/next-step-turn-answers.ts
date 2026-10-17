/**
 * The host is the authority on a conversation's current turn: the latest finished turn it
 * observed. It reads the reply's own proposed steps itself, a newer turn retires every older open
 * set, and one answer to any set of a turn settles the whole turn.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import { parsedNextStepSuggestionsFromText } from '../../shared/native-chat-next-action'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { NextStepsCurrentResult } from '../../shared/next-step-suggestions-rpc'
import type { NextStepSuggestionService } from './next-step-suggestion-service'
import type { FinishedTurn, TurnPlacement } from './next-step-turn-signal'

const OPEN_STATUSES = new Set<NextStepSuggestionSet['status']>(['generating', 'pending'])
const ANSWERED_STATUSES = new Set<NextStepSuggestionSet['status']>(['accepted', 'dismissed'])

export const NEXT_STEP_TURN_ANSWERED_REASON = 'This turn was already answered.'
export const NEXT_STEP_NEWER_TURN_REASON = 'A newer turn finished.'

/** The latest finished turn the host observed for a conversation; `turn` when it had a reply. */
export type ObservedTurn = TurnPlacement & { turnKey: string; turn?: FinishedTurn }

/** How a reported turn relates to the current one. */
export type TurnObservation = 'newer' | 'same' | 'older'

export const NEXT_STEP_OLDER_TURN_REASON = 'An older turn was reported after a newer one.'
export const NEXT_STEP_FALLBACK_ANSWERED_REASON = "Answered from the reply's own suggestions."

/** The key a client-offered set is stored under; the first real turn supersedes it. */
export function nextStepFallbackTurnKey(
  conversation: ConversationSource,
  messageId: string
): string {
  return `${conversation.paneKey}@reply:${messageId}`.slice(0, 1000)
}

const isFallbackTurnKey = (conversation: ConversationSource, turnKey: string): boolean =>
  turnKey.startsWith(`${conversation.paneKey}@reply:`)

export const NEXT_STEP_TURN_UNCONFIRMED_REASON = 'The current turn could not be confirmed.'

export const NEXT_STEP_EXTRA_DISMISSED_REASON = "Dismissed; the reply's own steps stay."

export const NEXT_STEP_EARLIER_TURN_REASON =
  'These suggestions are for an earlier turn and can no longer be answered.'

/** The reply's own proposed steps, with ids short enough for the wire (`s1`, `s2`, …). */
export function nextStepsFromReply(text: string): NextStepSuggestion[] {
  return parsedNextStepSuggestionsFromText(text).map((step, at) => ({ ...step, id: `s${at + 1}` }))
}

export function nextStepTurnSets(
  service: NextStepSuggestionService,
  key: string,
  turnKey: string
): NextStepSuggestionSet[] {
  return service.deps.store
    .list()
    .filter(
      (set) =>
        set.turnKey === turnKey &&
        set.conversation !== undefined &&
        conversationSourceRowKey(set.conversation) === key
    )
}

export function nextStepTurnHasAnswer(
  service: NextStepSuggestionService,
  turn: Pick<FinishedTurn, 'conversation' | 'turnKey'>
): boolean {
  return nextStepTurnSets(service, conversationSourceRowKey(turn.conversation), turn.turnKey).some(
    (set) => ANSWERED_STATUSES.has(set.status)
  )
}

/**
 * A reported turn (finished or skipped). Only a LATER turn by the host's own order becomes
 * current: it supersedes every older open set and aborts its call. A replayed older turn changes
 * nothing, and a repeated report of the same turn only fills in its reply. The reply's own steps
 * become the current turn's parsed set, and a turn that has them gets no automatic AI call.
 */
export function observeNextStepTurn(
  service: NextStepSuggestionService,
  conversation: ConversationSource,
  turnKey: string,
  turn?: FinishedTurn,
  placement: TurnPlacement = {}
): TurnObservation {
  const key = conversationSourceRowKey(conversation)
  const order = turn?.order ?? placement.order
  const completedAt = turn?.completedAt ?? placement.completedAt
  const previous = service.currentTurns.get(key)
  if (previous?.turnKey === turnKey) {
    if (turn && !previous.turn) {
      service.currentTurns.set(key, { ...previous, turn })
    }
    offerReplySteps(service, conversation, turnKey, turn)
    return 'same'
  }
  if (previous?.order !== undefined && order !== undefined && order < previous.order) {
    return 'older'
  }
  const carried = previous ? undefined : answeredFallback(service, conversation, completedAt)
  service.currentTurns.set(key, {
    turnKey,
    ...(order !== undefined ? { order } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(turn ? { turn } : {})
  })
  service.supersedeOpenSets(key, (set) => set.turnKey !== turnKey, NEXT_STEP_NEWER_TURN_REASON)
  service.scheduler.abort(key, 'newer-turn')
  if (carried) {
    // The person already answered this reply through the fallback set: the turn is answered.
    service.deps.store.upsert({
      ...service.newSet({ conversation, turnKey }, 'parsed', carried.status, carried.suggestions),
      error: NEXT_STEP_FALLBACK_ANSWERED_REASON
    })
    return 'newer'
  }
  offerReplySteps(service, conversation, turnKey, turn)
  return 'newer'
}

function offerReplySteps(
  service: NextStepSuggestionService,
  conversation: ConversationSource,
  turnKey: string,
  turn: FinishedTurn | undefined
): void {
  const steps = turn ? nextStepsFromReply(turn.lastAssistantMessage) : []
  if (steps.length && !service.findSet(conversationSourceRowKey(conversation), turnKey, 'parsed')) {
    registerParsedNextSteps(service, conversation, turnKey, steps)
  }
}

/**
 * The client-offered set for the reply this first real turn wrote, when the person already
 * answered it: offered after the turn completed (a set offered before it answers an older reply).
 */
function answeredFallback(
  service: NextStepSuggestionService,
  conversation: ConversationSource,
  completedAt: number | undefined
): NextStepSuggestionSet | undefined {
  const key = conversationSourceRowKey(conversation)
  const fallback = service.deps.store
    .list()
    .filter(
      (set) =>
        set.origin === 'parsed' &&
        set.conversation !== undefined &&
        conversationSourceRowKey(set.conversation) === key &&
        isFallbackTurnKey(conversation, set.turnKey)
    )
    .toSorted((left, right) => right.createdAt - left.createdAt)[0]
  return fallback &&
    ANSWERED_STATUSES.has(fallback.status) &&
    (completedAt === undefined || fallback.createdAt >= completedAt)
    ? fallback
    : undefined
}

/** The newest client-offered set's turn, when the conversation has one. */
function newestFallbackTurnKey(
  service: NextStepSuggestionService,
  conversation: ConversationSource
): string | null {
  const key = conversationSourceRowKey(conversation)
  return (
    service.deps.store
      .list()
      .filter(
        (set) =>
          set.conversation !== undefined &&
          conversationSourceRowKey(set.conversation) === key &&
          isFallbackTurnKey(conversation, set.turnKey)
      )
      .toSorted((left, right) => right.createdAt - left.createdAt)[0]?.turnKey ?? null
  )
}

/**
 * The turn a set must belong to for an answer to be taken: one the host positively established,
 * or, for a conversation it positively knows never reported a turn, its newest fallback set.
 * Null when neither could be confirmed (after a restart whose turn read failed, for one).
 */
export async function confirmedNextStepTurnKey(
  service: NextStepSuggestionService,
  conversation: ConversationSource
): Promise<string | null> {
  const { observed, known } = await currentNextStepTurn(service, conversation)
  if (!known) {
    return null
  }
  return observed?.turnKey ?? newestFallbackTurnKey(service, conversation)
}

/**
 * The latest finished turn observed for this conversation, reading it back after a restart.
 * `known: false` when that read failed: unknown is not "never seen".
 */
export async function currentNextStepTurn(
  service: NextStepSuggestionService,
  conversation: ConversationSource
): Promise<{ observed: ObservedTurn | null; known: boolean }> {
  const key = conversationSourceRowKey(conversation)
  const known = service.currentTurns.get(key)
  if (known) {
    return { observed: known, known: true }
  }
  let turn: FinishedTurn | null = null
  try {
    turn = (await service.deps.readLatestTurn?.(conversation)) ?? null
  } catch {
    return { observed: null, known: false }
  }
  if (turn && !service.currentTurns.has(key)) {
    service.latestTurns.set(key, turn)
    observeNextStepTurn(service, conversation, turn.turnKey, turn)
  }
  return { observed: service.currentTurns.get(key) ?? null, known: true }
}

/** The conversation's current turn and its sets; a client never derives a turn key itself. */
export async function currentNextSteps(
  service: NextStepSuggestionService,
  conversation: ConversationSource
): Promise<NextStepsCurrentResult> {
  const key = conversationSourceRowKey(conversation)
  const { observed, known } = await currentNextStepTurn(service, conversation)
  // Nothing actionable unless the host positively established the turn.
  const turnKey = known ? (observed?.turnKey ?? newestFallbackTurnKey(service, conversation)) : null
  const sets = turnKey ? nextStepTurnSets(service, key, turnKey) : []
  const newest = (origin: NextStepSuggestionSet['origin']) =>
    sets
      .filter((set) => set.origin === origin)
      .toSorted((left, right) => right.createdAt - left.createdAt)[0]
  const ai = newest('ai')
  const parsed = newest('parsed')
  const { storageError } = service.deps.store
  const doneness = turnKey ? service.deps.readDoneness?.(turnKey) : undefined
  return {
    turnKey,
    ...(ai ? { ai } : {}),
    ...(parsed ? { parsed } : {}),
    answered:
      sets.some((set) => ANSWERED_STATUSES.has(set.status)) &&
      !sets.some((set) => OPEN_STATUSES.has(set.status)),
    turnObserved: known ? observed !== null : null,
    ...(observed?.completedAt !== undefined ? { turnCompletedAt: observed.completedAt } : {}),
    revision: service.revision,
    ...(storageError ? { storageError } : {}),
    ...(doneness ? { doneness } : {})
  }
}

/**
 * The fallback for an agent the host never sees finish a turn: the client offers the steps it
 * read from a reply. Taken only while no turn was ever observed for the conversation, under the
 * reply's own key; the first real turn supersedes it. A refusal is returned in plain words.
 */
export async function offerParsedForReply(
  service: NextStepSuggestionService,
  conversation: ConversationSource,
  messageId: string,
  suggestions: NextStepSuggestion[]
): Promise<NextStepSuggestionSet | string> {
  const { observed, known } = await currentNextStepTurn(service, conversation)
  if (!known) {
    return 'Whether this conversation reports its own turns could not be read.'
  }
  if (observed) {
    return 'This conversation reports its own turns; the host reads their suggestions itself.'
  }
  const key = conversationSourceRowKey(conversation)
  const turnKey = nextStepFallbackTurnKey(conversation, messageId)
  const existing = service.findSet(key, turnKey, 'parsed')
  if (existing) {
    return existing
  }
  service.supersedeOpenSets(key, (set) => set.turnKey !== turnKey, NEXT_STEP_NEWER_TURN_REASON)
  return registerParsedNextSteps(service, conversation, turnKey, suggestions, messageId)
}

/** A parsed set for a turn; one per turn, settled at once when the turn is already answered. */
export function registerParsedNextSteps(
  service: NextStepSuggestionService,
  conversation: ConversationSource,
  turnKey: string,
  suggestions: NextStepSuggestion[],
  messageId?: string
): NextStepSuggestionSet {
  const key = conversationSourceRowKey(conversation)
  const existing = service.findSet(key, turnKey, 'parsed')
  if (existing) {
    return existing
  }
  // The reply's own steps lead: an AI set on the same turn never retires them.
  const reason = nextStepTurnHasAnswer(service, { conversation, turnKey })
    ? NEXT_STEP_TURN_ANSWERED_REASON
    : null
  const status = reason ? 'superseded' : 'pending'
  return service.deps.store.upsert({
    ...service.newSet({ conversation, turnKey }, 'parsed', status, suggestions),
    ...(reason ? { error: reason } : {}),
    ...(messageId ? { messageId } : {})
  })
}

/**
 * An answer to one set settles the turn: every other open set for it is superseded and its
 * in-flight call aborted, so a late AI result can never reopen an answered turn.
 */
export function settleNextStepTurn(
  service: NextStepSuggestionService,
  answered: NextStepSuggestionSet
): void {
  if (!answered.conversation) {
    return
  }
  const key = conversationSourceRowKey(answered.conversation)
  const reason =
    answered.origin === 'parsed'
      ? "Answered from the reply's own suggestions."
      : "Answered from the AI's suggestions."
  service.supersedeOpenSets(
    key,
    (set) => set.id !== answered.id && set.turnKey === answered.turnKey,
    reason
  )
  if (service.currentTurns.get(key)?.turnKey === answered.turnKey) {
    service.scheduler.abort(key, 'answered')
  }
}
