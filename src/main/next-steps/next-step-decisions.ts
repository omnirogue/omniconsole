/**
 * The person's answer to a set — run some, save some, dismiss — logged the same way whether the
 * set was read from the reply or written by the suggester.
 */

import { z } from 'zod'
import {
  combinedNextStepOptionsPrompt,
  hasUniqueNextStepIds,
  NEXT_STEP_OPTION_GROUP_MAX,
  type NextStepDecision,
  type NextStepSuggestion,
  type NextStepSuggestionSet
} from '../../shared/next-step-suggestions'
import {
  offeredSuggestionSchema,
  toNextStepSuggestions
} from '../../shared/next-step-suggestion-output'
import type {
  NextStepNotQueued,
  NextStepsDecideResult
} from '../../shared/next-step-suggestions-rpc'
import type {
  PromptQueueEntryOrigin,
  PromptQueueRequestedBy
} from '../../shared/prompt-queue-types'
import { salvagingArray } from '../../shared/zod-salvage'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { NextStepSuggestionService } from './next-step-suggestion-service'
import {
  confirmedNextStepTurnKey,
  NEXT_STEP_EARLIER_TURN_REASON,
  NEXT_STEP_EXTRA_DISMISSED_REASON,
  nextStepTurnSets,
  NEXT_STEP_TURN_ANSWERED_REASON,
  NEXT_STEP_TURN_UNCONFIRMED_REASON,
  nextStepTurnHasAnswer,
  settleNextStepTurn
} from './next-step-turn-answers'
import type { NextStepLoggedDecision } from './next-step-suggestion-store'
import { relayPinRefusal, type NextStepRelayPin } from './next-step-relay-pin'

export type NextStepAutoRound = {
  prefix: string
  origin: PromptQueueEntryOrigin
  /**
   * Keep going's own conditions, re-read synchronously after decide's last await and immediately
   * before the claim and enqueue. A string refuses the round: nothing is claimed or queued.
   */
  recheck: (set: NextStepSuggestionSet) => string | null
}

/**
 * A person's answer relayed by another conversation they asked (`omni session continue --yes`):
 * the same run as a click, behind a visible marker and with the relaying session as provenance.
 */
export type NextStepRelayedRun = {
  prefix: string
  requestedBy: PromptQueueRequestedBy
  via: string
  /** The exact step the relaying session checked; anything else is refused (`next-step-relay-pin`). */
  pinned?: NextStepRelayPin
}

/** Queue-entry id for one accepted suggestion; the queue ignores a repeat, so a double click queues once. */
export function nextStepPromptQueueEntryId(setId: string, suggestionId: string): string {
  return `next-step:${setId}:${suggestionId}`.slice(0, 200)
}

function decisionRecord(
  set: NextStepSuggestionSet,
  decision: NextStepDecision,
  at: number,
  notQueued: NextStepNotQueued[] = [],
  via?: string
): NextStepLoggedDecision {
  return {
    at,
    setId: set.id,
    origin: set.origin,
    ...(set.model ? { model: set.model } : {}),
    offered: set.suggestions.map(({ id, title, risk, kind }) => ({ id, title, risk, kind })),
    decision,
    ...(notQueued.length ? { notQueued } : {}),
    ...(via ? { via } : {})
  }
}

function enqueueChosen(
  service: NextStepSuggestionService,
  set: NextStepSuggestionSet,
  suggestionIds: readonly string[],
  auto: NextStepAutoRound | undefined,
  relay?: NextStepRelayedRun
): { queued: string[]; notQueued: NextStepNotQueued[] } {
  // A relayed run is the same run as a click, so only Keep going's own round changes grouping;
  // the relay only adds its marker and provenance to the queued entry.
  const tag:
    | { prefix: string; origin?: PromptQueueEntryOrigin; requestedBy?: PromptQueueRequestedBy }
    | undefined = auto ?? relay
  const chosen = new Set(suggestionIds)
  const known = new Set(set.suggestions.map((suggestion) => suggestion.id))
  const notQueued: NextStepNotQueued[] = [...chosen]
    .filter((id) => !known.has(id))
    .map((id) => ({ id, reason: 'That suggestion is not in this set.' }))
  const conversation = set.conversation
  const queued: string[] = []
  // The set's order, not the click order: suggestions are ranked by value.
  for (const entry of queueEntriesOf(set, chosen, auto)) {
    if (!conversation) {
      notQueued.push(
        ...entry.ids.map((id) => ({ id, reason: 'There is no conversation to send it to yet.' }))
      )
      continue
    }
    try {
      service.deps.enqueue(conversation, {
        id: nextStepPromptQueueEntryId(set.id, entry.key),
        text: `${tag?.prefix ?? ''}${entry.prompt}`,
        ...(tag?.origin ? { origin: tag.origin } : {}),
        ...(tag?.requestedBy ? { requestedBy: tag.requestedBy } : {})
      })
      queued.push(...entry.ids)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      notQueued.push(...entry.ids.map((id) => ({ id, reason })))
    }
  }
  return { queued, notQueued }
}

type QueueEntry = { key: string; ids: string[]; prompt: string }

/**
 * One queue entry per chosen step, except that several options chosen from one offered menu
 * (`optionGroup`) go as ONE message at the first one's place: "do 1, 2 and 4" is one piece of
 * work, not three turns. Keep going runs a single step and never combines.
 */
function queueEntriesOf(
  set: NextStepSuggestionSet,
  chosen: ReadonlySet<string>,
  auto: NextStepAutoRound | undefined
): QueueEntry[] {
  const picked = set.suggestions.filter((suggestion) => chosen.has(suggestion.id))
  const groupSize = new Map<string, number>()
  for (const step of picked) {
    if (step.optionGroup && !auto) {
      groupSize.set(step.optionGroup, (groupSize.get(step.optionGroup) ?? 0) + 1)
    }
  }
  const entries: QueueEntry[] = []
  const placed = new Set<string>()
  for (const step of picked) {
    const group =
      step.optionGroup && (groupSize.get(step.optionGroup) ?? 0) > 1 ? step.optionGroup : null
    if (!group) {
      entries.push({ key: step.id, ids: [step.id], prompt: step.prompt })
      continue
    }
    if (placed.has(group)) {
      continue
    }
    placed.add(group)
    const members = picked.filter((member) => member.optionGroup === group)
    entries.push({
      key: members.map((member) => member.id).join('+'),
      ids: members.map((member) => member.id),
      prompt: combinedNextStepOptionsPrompt(members)
    })
  }
  return entries
}

async function appendLogged(
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

/**
 * The set is claimed (`pending → accepted|dismissed`) synchronously, before anything can await, so
 * two answers or a supersede cannot both act on it. Only what was really queued is logged.
 */
export async function decideNextSteps(
  service: NextStepSuggestionService,
  setId: string,
  decision: NextStepDecision,
  now: number = Date.now(),
  /** Keep going's round: its visible marker and the provenance its queue entry carries. */
  autoRound?: NextStepAutoRound,
  /** A person's run relayed by another session; ignored for Keep going's own rounds. */
  relayed?: NextStepRelayedRun
): Promise<NextStepsDecideResult> {
  const { store } = service.deps
  const asked = store.get(setId)
  if (!asked) {
    throw new Error('Those suggestions are no longer available.')
  }
  // Only a turn the host positively established can be answered; read before anything is claimed.
  const currentTurnKey = asked.conversation
    ? await confirmedNextStepTurnKey(service, asked.conversation)
    : undefined
  const set = store.get(setId)
  if (!set) {
    throw new Error('Those suggestions are no longer available.')
  }
  if (!hasUniqueNextStepIds(set)) {
    throw new Error('These suggestions repeat an id and cannot be answered safely.')
  }
  if (set.status !== 'pending') {
    throw new Error(`These suggestions are ${set.status} and can no longer be answered.`)
  }
  // A turn's set without its conversation cannot be placed on a turn; only `start` sets lack one.
  if (!set.conversation && set.origin !== 'start') {
    throw new Error('These suggestions have no conversation and can no longer be answered.')
  }
  if (set.conversation) {
    if (currentTurnKey === null) {
      throw new Error(NEXT_STEP_TURN_UNCONFIRMED_REASON)
    }
    // Only the conversation's current turn can be answered; an older set is history.
    if (currentTurnKey !== set.turnKey) {
      throw new Error(NEXT_STEP_EARLIER_TURN_REASON)
    }
    // Defensive: a turn another answer already settled is never answered twice.
    if (nextStepTurnHasAnswer(service, { conversation: set.conversation, turnKey: set.turnKey })) {
      throw new Error(NEXT_STEP_TURN_ANSWERED_REASON)
    }
  }
  const auto = decision.action === 'run' && decision.auto ? autoRound : undefined
  const pin = auto ? undefined : relayed?.pinned
  const refused =
    auto?.recheck(set) ??
    (pin && decision.action === 'run' ? relayPinRefusal(set, decision.suggestionIds, pin) : null)
  if (refused) {
    throw new Error(refused)
  }
  if (decision.action === 'dismiss' && dismissesOnlyExtraSteps(service, set)) {
    // The AI's extra steps go; the reply's own steps stay the turn's open answer.
    store.update(setId, (current) => ({
      ...current,
      status: 'superseded',
      error: NEXT_STEP_EXTRA_DISMISSED_REASON
    }))
    const logError = await appendLogged(service, decisionRecord(set, decision, now))
    return {
      set: store.get(setId) ?? set,
      queued: [],
      notQueued: [],
      ...(logError ? { logError } : {})
    }
  }
  const claimed = decision.action === 'dismiss' ? 'dismissed' : 'accepted'
  store.update(setId, (current) => ({ ...current, status: claimed }))
  if (decision.action !== 'run') {
    settleNextStepTurn(service, set)
    const logError = await appendLogged(service, decisionRecord(set, decision, now))
    return {
      set: store.get(setId) ?? set,
      queued: [],
      notQueued: [],
      ...(logError ? { logError } : {})
    }
  }
  const relay = auto ? undefined : relayed
  const result = enqueueChosen(service, set, decision.suggestionIds, auto, relay)
  if (!result.queued.length) {
    // Nothing reached the queue: reopen it, unless something else settled it meanwhile.
    if (store.get(setId)?.status === 'accepted') {
      store.update(setId, (current) => ({ ...current, status: 'pending' }))
    }
    return { set: store.get(setId) ?? set, ...result }
  }
  settleNextStepTurn(service, set)
  const logged: NextStepDecision = {
    action: 'run',
    suggestionIds: result.queued,
    ...(decision.auto ? { auto: true } : {}),
    ...(decision.auto && decision.adPause ? { adPause: true } : {})
  }
  const logError = await appendLogged(
    service,
    decisionRecord(set, logged, now, result.notQueued, relay?.via)
  )
  return { set: store.get(setId) ?? set, ...result, ...(logError ? { logError } : {}) }
}

/** An AI set offered beside the reply's own still-open steps (the person asked for more). */
function dismissesOnlyExtraSteps(
  service: NextStepSuggestionService,
  set: NextStepSuggestionSet
): boolean {
  if (set.origin !== 'ai' || !set.conversation) {
    return false
  }
  const key = conversationSourceRowKey(set.conversation)
  return nextStepTurnSets(service, key, set.turnKey).some(
    (sibling) => sibling.origin === 'parsed' && sibling.status === 'pending'
  )
}

const offeredListSchema = salvagingArray(
  offeredSuggestionSchema.extend({
    offered: z.literal(true).optional().catch(undefined),
    preselected: z.literal(true).optional().catch(undefined),
    optionGroup: z.string().min(1).max(NEXT_STEP_OPTION_GROUP_MAX).optional().catch(undefined)
  })
)

/**
 * The offered items the host can read; one bad item does not void the offer. The reply's own
 * marks (offered, pre-ticked, one menu) ride along, as they do for a set the host parsed itself.
 */
export function readOfferedNextSteps(raw: unknown): NextStepSuggestion[] {
  const parsed = z.unknown().pipe(offeredListSchema).safeParse(raw)
  const suggestions = parsed.success
    ? toNextStepSuggestions(parsed.data, { keepIds: true }).map((step, index) => {
        const { offered, preselected, optionGroup } = parsed.data[index]!
        return {
          ...step,
          ...(offered ? { offered } : {}),
          ...(preselected ? { preselected } : {}),
          ...(optionGroup ? { optionGroup } : {})
        }
      })
    : []
  if (!hasUniqueNextStepIds({ suggestions })) {
    throw new Error('The offered suggestions repeat an id.')
  }
  if (!suggestions.length) {
    throw new Error('None of the offered suggestions could be read.')
  }
  return suggestions
}
