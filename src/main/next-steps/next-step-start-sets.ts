/**
 * Suggested starts: what a NEW conversation is offered before its first message. One set per
 * workspace per hour. Carry-over (steps the last conversation here was offered and never answered)
 * shows at once and needs no model call; one suggester call may add better first steps.
 *
 * Nothing runs here. Accepting binds the set to the conversation that took it and queues the
 * chosen prompts in order through the prompt queue: the first one is that conversation's first
 * message, and each later one waits until the agent is free again.
 */

import { randomUUID } from 'node:crypto'
import {
  NEXT_STEP_SUGGESTION_MAX,
  type NextStepSuggestion,
  type NextStepSuggestionSet
} from '../../shared/next-step-suggestions'
import type { NextStepsGenerateResult } from '../../shared/next-step-suggestions-rpc'
import {
  carryOverSource,
  collectCarryOver,
  previousOpenStartSet,
  settleCarriedSource
} from './next-step-start-carry-over'
import type { NextStepStartRequest } from './next-step-start-generator'
import type {
  NextStepGenerateOutcome,
  NextStepSuggestionService
} from './next-step-suggestion-service'
import { nextStepFallbackLane } from './next-step-workspace'

export const NEXT_STEP_START_OFF_REASON =
  'Suggested next steps are turned off in settings, and the last session here left no steps unanswered.'

// A failed or superseded set is asked again; any other answer holds for the hour.
const REUSABLE = new Set<NextStepSuggestionSet['status']>([
  'generating',
  'pending',
  'accepted',
  'dismissed'
])

/** One start set per workspace per hour (UTC): `start:<worktreeId>:<yyyy-mm-dd-hh>`. */
export function nextStepStartTurnKey(worktreeId: string, now: number): string {
  const hour = new Date(now).toISOString().slice(0, 13).replace('T', '-')
  return `start:${worktreeId}:${hour}`
}

function startJobKey(worktreeId: string): string {
  return `start\u0000${worktreeId}`
}

/** The AI's first steps, then carry-over it did not already repeat; at most the set maximum. */
export function mergeStartSuggestions(
  written: readonly NextStepSuggestion[],
  carryOver: readonly NextStepSuggestion[]
): NextStepSuggestion[] {
  const titleKey = (suggestion: NextStepSuggestion) => suggestion.title.trim().toLowerCase()
  const titles = new Set(written.map(titleKey))
  const ids = new Set<string>()
  // Why ids too: a set that repeats an id can never be answered, so a repeat is dropped here.
  return [...written, ...carryOver.filter((suggestion) => !titles.has(titleKey(suggestion)))]
    .filter((suggestion) => !ids.has(suggestion.id) && Boolean(ids.add(suggestion.id)))
    .slice(0, NEXT_STEP_SUGGESTION_MAX)
}

/**
 * A start set's `createdAt` doubles as its workspace generation: strictly greater than every
 * earlier start set here, even within one millisecond, so "newer" is never a tie.
 */
function nextStartGeneration(
  sets: readonly NextStepSuggestionSet[],
  worktreeId: string,
  now: number
): number {
  const latest = sets
    .filter((set) => set.origin === 'start' && set.worktreeId === worktreeId)
    .reduce((max, set) => Math.max(max, set.createdAt), -Infinity)
  return Math.max(now, latest + 1)
}

function newestStartSet(
  sets: readonly NextStepSuggestionSet[],
  worktreeId: string,
  turnKey: string
): NextStepSuggestionSet | undefined {
  return sets
    .filter(
      (set) => set.origin === 'start' && set.worktreeId === worktreeId && set.turnKey === turnKey
    )
    .toSorted((left, right) => right.createdAt - left.createdAt)[0]
}

function retireOpenStartSets(service: NextStepSuggestionService, worktreeId: string): void {
  service.scheduler.abort(startJobKey(worktreeId), 'superseded')
  for (const set of service.deps.store.list()) {
    if (
      set.origin === 'start' &&
      set.worktreeId === worktreeId &&
      !set.conversation &&
      (set.status === 'generating' || set.status === 'pending' || set.status === 'failed')
    ) {
      service.deps.store.update(set.id, (current) => ({ ...current, status: 'superseded' }))
    }
  }
}

async function runStartGeneration(
  service: NextStepSuggestionService,
  setId: string,
  generate: () => Promise<NextStepGenerateOutcome>,
  signal: AbortSignal
): Promise<void> {
  const outcome = await generate().catch((error: unknown): NextStepGenerateOutcome => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }))
  const { store } = service.deps
  const current = store.get(setId)
  if (current?.status !== 'generating') {
    return
  }
  if (signal.aborted || !outcome.ok) {
    const error = outcome.ok ? 'Suggestions were cancelled.' : outcome.error
    // Carry-over stays usable when the call fails; it needed no model.
    store.upsert({ ...current, status: current.suggestions.length ? 'pending' : 'failed', error })
    return
  }
  store.upsert({
    ...current,
    status: 'pending',
    suggestions: mergeStartSuggestions(outcome.suggestions, current.suggestions),
    ...(outcome.model ? { model: outcome.model } : {})
  })
}

export type NextStepStartParams = {
  worktreeId: string
  taskId?: string
  agent?: string
  force?: boolean
}

/** The workspace's start set for this hour; `force` asks again. Carry-over only when turned off. */
export function suggestNextStepStart(
  service: NextStepSuggestionService,
  params: NextStepStartParams,
  now: number = Date.now()
): NextStepsGenerateResult {
  const { store } = service.deps
  const turnKey = nextStepStartTurnKey(params.worktreeId, now)
  const cached = newestStartSet(store.list(), params.worktreeId, turnKey)
  if (cached && !params.force && REUSABLE.has(cached.status)) {
    return { set: cached }
  }
  // Why before retiring: a retry, or a new hour, keeps what the last start set carried.
  const previous = previousOpenStartSet(store.list(), params.worktreeId)
  const source = carryOverSource(store.list(), params.worktreeId, service.deps.isConversationLive)
  // Created with unique ids only: a repeated id would make the set unanswerable.
  const carryOver = mergeStartSuggestions([], collectCarryOver(source, previous))
  retireOpenStartSets(service, params.worktreeId)
  const generateStart = service.deps.generateStart
  const enabled = service.deps.settings().enabled && generateStart !== undefined
  if (!enabled && !carryOver.length) {
    service.recordSkip(NEXT_STEP_START_OFF_REASON, undefined, turnKey)
    return { set: null, skipped: NEXT_STEP_START_OFF_REASON }
  }
  const set = store.upsert({
    id: randomUUID(),
    worktreeId: params.worktreeId,
    turnKey,
    origin: 'start',
    createdAt: nextStartGeneration(store.list(), params.worktreeId, now),
    status: enabled ? 'generating' : 'pending',
    suggestions: carryOver
  })
  if (source) {
    settleCarriedSource(service, source)
  }
  if (!enabled || !generateStart) {
    return { set }
  }
  const request: NextStepStartRequest = {
    worktreeId: params.worktreeId,
    carryOver,
    ...(params.agent ? { agent: params.agent } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {})
  }
  service.scheduler.schedule(
    {
      key: startJobKey(params.worktreeId),
      lane:
        service.deps.workspaceLaneOf?.(params.worktreeId) ??
        nextStepFallbackLane(params.worktreeId),
      run: (signal) =>
        runStartGeneration(service, set.id, () => generateStart(request, signal), signal),
      onDropped: () => {
        if (store.get(set.id)?.status === 'generating') {
          store.update(set.id, (current) => ({ ...current, status: 'superseded' }))
        }
      }
    },
    { immediate: true }
  )
  return { set: store.get(set.id) ?? set }
}
