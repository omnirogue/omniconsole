/**
 * JEV's advisory reading of how done a conversation's work is after a turn: four yes/no questions
 * in one request. It never finishes a card or an outcome; an unsure reading stops nothing.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import { nextStepDonenessIsUnsure, type NextStepDoneness } from '../../shared/next-step-doneness'
import {
  describeNextStepGitFacts,
  NEXT_STEP_ASSISTANT_TAIL_MAX,
  type NextStepGitFacts,
  type NextStepGitFactsUnavailable
} from '../../shared/next-step-suggestion-prompt'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { jevDecide, type JevRankOptions } from '../structured-decisions/jev-rank'
import { fitJevText } from '../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../structured-decisions/typesafe-provider'
import { NEXT_STEP_JEV_CAPABILITY, noteNextStepJevFailure } from './next-step-jev-rank'

export type NextStepDonenessInput = {
  conversation: ConversationSource
  turnKey: string
  /** What the person originally asked for (`resolveNextStepGoal`). */
  goal: string
  /** The end of the agent's latest reply. */
  replyTail: string
  gitFacts?: NextStepGitFacts | NextStepGitFactsUnavailable
}

export type NextStepDonenessOptions = JevRankOptions & {
  now?: () => number
  cache?: NextStepDonenessCache
}

export const NEXT_STEP_DONENESS_QUESTIONS = {
  resolved:
    "Is the person's ORIGINAL request (the goal) resolved by the work so far, as the work shows it?",
  remaining_work:
    'Is required work toward the goal still missing or unfinished (not optional extras or polish)?',
  room_to_improve:
    'Is there meaningful room left to improve the work toward the goal (not polish for its own sake)?',
  verified:
    'Does the work show evidence it was checked: tests ran, a page loaded, or output was inspected?'
} as const

const MAX_CACHED = 200

/** Readings per turn, and the call in flight for a turn, so one turn asks JEV at most once. */
export class NextStepDonenessCache {
  private readonly readings = new Map<string, NextStepDoneness>()
  readonly inFlight = new Map<string, Promise<NextStepDoneness | null>>()

  get(turnKey: string): NextStepDoneness | undefined {
    return this.readings.get(turnKey)
  }

  set(reading: NextStepDoneness): void {
    this.readings.delete(reading.turnKey)
    this.readings.set(reading.turnKey, reading)
    for (const key of this.readings.keys()) {
      if (this.readings.size <= MAX_CACHED) {
        break
      }
      this.readings.delete(key)
    }
  }
}

/** The host's one cache: the tray's `nextSteps.current` and Keep going read the same reading. */
export const nextStepDonenessCache = new NextStepDonenessCache()

export function buildNextStepDonenessRequest(input: NextStepDonenessInput): DecisionRequest {
  const tail = input.replyTail.trim()
  const reply =
    tail.length > NEXT_STEP_ASSISTANT_TAIL_MAX
      ? `…${tail.slice(tail.length - NEXT_STEP_ASSISTANT_TAIL_MAX)}`
      : tail
  const work = [
    '## The agent answered (end of its latest reply)',
    reply,
    ...(input.gitFacts
      ? ['', '## Workspace git state', describeNextStepGitFacts(input.gitFacts)]
      : [])
  ].join('\n')
  return {
    capability: NEXT_STEP_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { goal: fitJevText(input.goal.trim(), 8_000), work: fitJevText(work, 40_000) },
    questions: Object.fromEntries(
      Object.entries(NEXT_STEP_DONENESS_QUESTIONS).map(([id, instructions]) => [
        id,
        { type: 'noul', instructions }
      ])
    )
  }
}

/** The four readings, or null when any is missing. `unsure` (display only) = any inside (0.2, 0.8). */
export function readNextStepDoneness(
  result: DecisionResult,
  turnKey: string,
  at: number
): NextStepDoneness | null {
  const yes = (id: keyof typeof NEXT_STEP_DONENESS_QUESTIONS): number | undefined => {
    const answer = result.answers[id]
    return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : undefined
  }
  const resolved = yes('resolved')
  const remainingWork = yes('remaining_work')
  const roomToImprove = yes('room_to_improve')
  const verified = yes('verified')
  if (
    resolved === undefined ||
    remainingWork === undefined ||
    roomToImprove === undefined ||
    verified === undefined
  ) {
    return null
  }
  return {
    resolved,
    remainingWork,
    roomToImprove,
    verified,
    unsure: [resolved, remainingWork, roomToImprove, verified].some(nextStepDonenessIsUnsure),
    turnKey,
    at
  }
}

/**
 * JEV's doneness reading for one finished turn, asked once per turn (cached, and a second caller
 * joins the call in flight). Null when there is no goal, or JEV is off, unavailable or failed.
 */
export function assessNextStepDoneness(
  input: NextStepDonenessInput,
  options: NextStepDonenessOptions = {}
): Promise<NextStepDoneness | null> {
  const cache = options.cache ?? nextStepDonenessCache
  const cached = cache.get(input.turnKey)
  if (cached) {
    return Promise.resolve(cached)
  }
  const running = cache.inFlight.get(input.turnKey)
  if (running) {
    return running
  }
  if (!input.goal.trim() || !input.replyTail.trim()) {
    return Promise.resolve(null)
  }
  const call = jevDecide(buildNextStepDonenessRequest(input), {
    ...options,
    caller: 'next-steps.doneness'
  })
    .then((result) => {
      if ('failed' in result) {
        noteNextStepJevFailure('doneness', result.failed)
        return null
      }
      const reading = readNextStepDoneness(result, input.turnKey, (options.now ?? Date.now)())
      if (reading) {
        cache.set(reading)
      }
      return reading
    })
    .finally(() => cache.inFlight.delete(input.turnKey))
  cache.inFlight.set(input.turnKey, call)
  return call
}
