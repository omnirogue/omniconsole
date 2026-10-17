/**
 * Which door a `nextSteps.decide` goes through, chosen by the STORED set, never by what the client
 * sent: a start set is answered from a fresh conversation that takes it; any other set only from
 * its own conversation.
 */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import {
  hasUniqueNextStepIds,
  type NextStepDecision,
  type NextStepSuggestionSet
} from '../../shared/next-step-suggestions'
import type {
  NextStepNotQueued,
  NextStepsDecideResult
} from '../../shared/next-step-suggestions-rpc'
import { decideNextSteps, nextStepPromptQueueEntryId } from './next-step-decisions'
import { hasNextStepStartActivity } from './next-step-start-activity'
import type { NextStepSuggestionService } from './next-step-suggestion-service'
import type { NextStepLoggedDecision } from './next-step-suggestion-store'

export const NEXT_STEP_START_NEEDS_CONVERSATION =
  'A suggested start is answered from the new conversation that takes it.'
export const NEXT_STEP_START_NOT_FRESH =
  'This conversation already has messages, so suggested starts no longer apply to it.'
export const NEXT_STEP_OTHER_CONVERSATION = 'These suggestions belong to another conversation.'

export async function routeNextStepDecision(
  service: NextStepSuggestionService,
  setId: string,
  decision: NextStepDecision,
  conversation: ConversationSource | undefined
): Promise<NextStepsDecideResult> {
  const set = service.deps.store.get(setId)
  if (!set) {
    throw new Error('Those suggestions are no longer available.')
  }
  if (set.origin === 'start') {
    if (!conversation) {
      throw new Error(NEXT_STEP_START_NEEDS_CONVERSATION)
    }
    return decideNextStepStart(service, setId, decision, conversation)
  }
  if (
    conversation &&
    (!set.conversation ||
      conversationSourceRowKey(set.conversation) !== conversationSourceRowKey(conversation))
  ) {
    throw new Error(NEXT_STEP_OTHER_CONVERSATION)
  }
  return decideNextSteps(service, setId, decision)
}

/**
 * Any sign the person already used this conversation: a turn the host observed, a turn signal
 * (busy, finished, skipped) seen by this process, any prompt-queue entry, or a set of its own.
 */
function conversationWasUsed(
  service: NextStepSuggestionService,
  set: NextStepSuggestionSet,
  conversation: ConversationSource
): boolean {
  const key = conversationSourceRowKey(conversation)
  return (
    service.currentTurns.has(key) ||
    hasNextStepStartActivity(service, key) ||
    (service.deps.readPromptQueue(conversation)?.entries.length ?? 0) > 0 ||
    service.deps.store
      .list()
      .some(
        (other) =>
          other.id !== set.id &&
          other.conversation !== undefined &&
          conversationSourceRowKey(other.conversation) === key
      )
  )
}

async function logDecision(
  service: NextStepSuggestionService,
  record: NextStepLoggedDecision
): Promise<string | undefined> {
  try {
    await service.deps.store.appendDecision(record)
    return undefined
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return `This decision could not be written to the decision log: ${detail}`
  }
}

export const NEXT_STEP_START_FRESHNESS_TIMEOUT_MS = 5_000
const START_ACTIONS = new Set<string>(['run', 'save', 'dismiss'])

/** True when the host has observed no turn; throws when it cannot tell, or not in time. */
async function freshWithin(
  service: NextStepSuggestionService,
  conversation: ConversationSource,
  timeoutMs: number
): Promise<boolean> {
  if (service.currentTurns.has(conversationSourceRowKey(conversation))) {
    return false
  }
  // Read directly, not through the turn cache: a reader that fails is "unknown", never "fresh".
  const check = service.deps.readLatestTurn
    ? service.deps.readLatestTurn(conversation)
    : Promise.resolve(null)
  // Why: the losing side of the race must never surface as an unhandled rejection.
  check.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('The host could not confirm this conversation is new.')),
      timeoutMs
    )
  })
  try {
    return (await Promise.race([check, timeout])) === null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The person's answer to a start set, for every action. The set is claimed for this conversation
 * synchronously, before anything awaits, so a second tab finds it answered. Every action needs a
 * conversation in the set's workspace in which the host has observed no turn. Run queues the
 * chosen prompts in the set's order, the first becoming the conversation's first message. Any path
 * that settles nothing — refused, failed, timed out, nothing queued — releases the claim; a partial
 * queue stays bound and names what was not queued.
 */
export async function decideNextStepStart(
  service: NextStepSuggestionService,
  setId: string,
  decision: NextStepDecision,
  conversation: ConversationSource,
  options: { now?: number; freshnessTimeoutMs?: number } = {}
): Promise<NextStepsDecideResult> {
  const { store } = service.deps
  const set = store.get(setId)
  if (!set) {
    throw new Error('Those suggestions are no longer available.')
  }
  if (set.origin !== 'start') {
    throw new Error('Only suggested starts are answered for a new conversation.')
  }
  if (!hasUniqueNextStepIds(set)) {
    throw new Error('These suggestions repeat an id and cannot be answered safely.')
  }
  if (!START_ACTIONS.has(decision.action)) {
    throw new Error('That answer is not one a suggested start accepts.')
  }
  if (set.worktreeId !== conversation.worktreeId) {
    throw new Error('These suggestions belong to another workspace.')
  }
  const key = conversationSourceRowKey(conversation)
  if (set.status !== 'pending' || set.conversation) {
    throw new Error(
      set.conversation && conversationSourceRowKey(set.conversation) !== key
        ? 'These suggestions were already taken by another conversation.'
        : `These suggestions are ${set.status} and can no longer be answered.`
    )
  }
  const chosen = decision.action === 'dismiss' ? [] : decision.suggestionIds
  const known = new Set(set.suggestions.map((suggestion) => suggestion.id))
  const unknown = chosen.filter((id) => !known.has(id))
  if (unknown.length) {
    throw new Error(`These suggestions are not in this set: ${unknown.join(', ')}.`)
  }
  if (conversationWasUsed(service, set, conversation)) {
    throw new Error(NEXT_STEP_START_NOT_FRESH)
  }
  if (hasNewerStartSet(service, set)) {
    throw new Error(NEXT_STEP_START_REPLACED)
  }
  const claimed = decision.action === 'dismiss' ? 'dismissed' : 'accepted'
  store.update(setId, (current) => ({ ...current, status: claimed, conversation }))
  let settled = false
  try {
    if (
      !(await freshWithin(
        service,
        conversation,
        options.freshnessTimeoutMs ?? NEXT_STEP_START_FRESHNESS_TIMEOUT_MS
      ))
    ) {
      throw new Error(NEXT_STEP_START_NOT_FRESH)
    }
    // The world may have moved during the await: re-check, synchronously, before settling.
    // Synchronous from here to the first enqueue: nothing can slip in between.
    assertStillAnswerable(service, set, claimed, conversation)
    const offered = set.suggestions.map(({ id, title, risk, kind }) => ({ id, title, risk, kind }))
    const record = (logged: NextStepDecision, notQueued: NextStepNotQueued[] = []) => ({
      at: options.now ?? Date.now(),
      setId,
      origin: set.origin,
      ...(set.model ? { model: set.model } : {}),
      offered,
      decision: logged,
      ...(notQueued.length ? { notQueued } : {})
    })
    if (decision.action !== 'run') {
      settled = true
      const logError = await logDecision(service, record(decision))
      return {
        set: store.get(setId) ?? set,
        queued: [],
        notQueued: [],
        ...(logError ? { logError } : {})
      }
    }
    const wanted = new Set(chosen)
    const queued: string[] = []
    const notQueued: NextStepNotQueued[] = []
    // The set's order, not the click order: the first queued is the first message.
    for (const suggestion of set.suggestions.filter((entry) => wanted.has(entry.id))) {
      try {
        service.deps.enqueue(conversation, {
          id: nextStepPromptQueueEntryId(setId, suggestion.id),
          text: suggestion.prompt
        })
        queued.push(suggestion.id)
      } catch (error) {
        notQueued.push({
          id: suggestion.id,
          reason: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (!queued.length) {
      release(service, setId, claimed, key)
      return { set: store.get(setId) ?? set, queued, notQueued }
    }
    settled = true
    const logError = await logDecision(
      service,
      record({ action: 'run', suggestionIds: queued }, notQueued)
    )
    return { set: store.get(setId) ?? set, queued, notQueued, ...(logError ? { logError } : {}) }
  } finally {
    if (!settled) {
      release(service, setId, claimed, key)
    }
  }
}

export const NEXT_STEP_START_REPLACED = 'Replaced by a newer start set.'
const NEXT_STEP_START_CLAIM_LOST = 'These suggestions were answered elsewhere meanwhile.'

/** Another start set for this workspace newer than this one (any hour, any status). */
function hasNewerStartSet(service: NextStepSuggestionService, set: NextStepSuggestionSet): boolean {
  return service.deps.store.list().some(
    (other) =>
      other.origin === 'start' &&
      other.worktreeId === set.worktreeId &&
      other.id !== set.id &&
      // createdAt is a per-workspace generation: creation keeps it strictly increasing.
      other.createdAt > set.createdAt
  )
}

function claimIsOurs(
  current: NextStepSuggestionSet | undefined,
  claimed: NextStepSuggestionSet['status'],
  key: string
): current is NextStepSuggestionSet {
  return Boolean(
    current?.status === claimed &&
    current.conversation &&
    conversationSourceRowKey(current.conversation) === key
  )
}

function assertStillAnswerable(
  service: NextStepSuggestionService,
  set: NextStepSuggestionSet,
  claimed: NextStepSuggestionSet['status'],
  conversation: ConversationSource
): void {
  if (
    !claimIsOurs(service.deps.store.get(set.id), claimed, conversationSourceRowKey(conversation))
  ) {
    throw new Error(NEXT_STEP_START_CLAIM_LOST)
  }
  if (conversationWasUsed(service, set, conversation)) {
    throw new Error(NEXT_STEP_START_NOT_FRESH)
  }
  if (hasNewerStartSet(service, set)) {
    throw new Error(NEXT_STEP_START_REPLACED)
  }
}

/**
 * Undoes this call's claim, and only this call's. A set a newer start set replaced meanwhile is
 * retired, never reopened, so only the newest start set can ever queue anything.
 */
function release(
  service: NextStepSuggestionService,
  setId: string,
  claimed: NextStepSuggestionSet['status'],
  key: string
): void {
  const current = service.deps.store.get(setId)
  if (!claimIsOurs(current, claimed, key)) {
    return
  }
  const replaced = hasNewerStartSet(service, current)
  service.deps.store.update(setId, ({ conversation: _taken, error: _error, ...rest }) => ({
    ...rest,
    status: replaced ? 'superseded' : 'pending',
    ...(replaced ? { error: NEXT_STEP_START_REPLACED } : {})
  }))
}
