import { createHash } from 'node:crypto'
/**
 * The JEV readings the steward's rules act on: the doneness reading suggested next steps already
 * take once per finished turn (shared cache), and one question of its own, "does this proposed
 * step advance what the person asked for?" (0–4), asked once per step. JEV only advises: with it
 * off there is no reading, nudges, questions and Tier 2 wait, and safe Yes runs on its mechanical
 * checks alone; the waiter check and wake-ups never ask it.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import { nextStepDonenessIsUnsure, type NextStepDoneness } from '../../shared/next-step-doneness'
import type { NextStepSuggestion } from '../../shared/next-step-suggestions'
import {
  nextStepJevSettings,
  type NextStepSuggestionSettings
} from '../../shared/next-step-suggestion-settings'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import type { NextStepJev } from '../next-steps/next-step-jev'
import { NEXT_STEP_JEV_CAPABILITY, noteNextStepJevFailure } from '../next-steps/next-step-jev-rank'
import {
  jevDecide,
  jevUnavailableReason,
  type JevRankOptions
} from '../structured-decisions/jev-rank'
import { fitJevText } from '../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../structured-decisions/typesafe-provider'

/** A step scoring at least this (of 4) stays inside the person's request. */
export const STEWARD_ADVANCE_PASS = 3
export const STEWARD_ADVANCE_QUESTION =
  'How well would doing the proposed step advance what the person originally asked for (the goal), while staying inside that request?'
export const STEWARD_ADVANCE_LEVELS = [
  'Outside the request, or against it',
  'Barely related to the request',
  'Somewhat advances the request',
  'Clearly advances the request',
  'Directly delivers the request'
]
const GOAL_BYTES = 8_000
const STEP_BYTES = 4_000
const CACHE_MAX = 200

/** The two readings the rules act on; `unsure` covers only those two. */
export type StewardDoneness = {
  turnKey: string
  resolved: number
  remainingWork: number
  unsure: boolean
}

export type StewardDonenessVerdict = 'finished' | 'work-left' | 'unclear'

export function stewardDonenessOf(reading: NextStepDoneness): StewardDoneness {
  return {
    turnKey: reading.turnKey,
    resolved: reading.resolved,
    remainingWork: reading.remainingWork,
    unsure:
      nextStepDonenessIsUnsure(reading.resolved) || nextStepDonenessIsUnsure(reading.remainingWork)
  }
}

/** Finished: resolved ≥ 0.8 with ≤ 0.2 left; work left: the reverse; anything else is unclear. */
export function stewardDonenessVerdict(reading: StewardDoneness): StewardDonenessVerdict {
  if (reading.unsure) {
    return 'unclear'
  }
  if (reading.resolved >= 0.8 && reading.remainingWork <= 0.2) {
    return 'finished'
  }
  return reading.remainingWork >= 0.8 && reading.resolved <= 0.2 ? 'work-left' : 'unclear'
}

export function buildStewardAdvanceRequest(
  goal: string,
  step: NextStepSuggestion
): DecisionRequest {
  const words = [
    `Title: ${step.title}`,
    `Prompt: ${step.prompt}`,
    ...(step.why ? [`Why: ${step.why}`] : [])
  ].join('\n')
  return {
    capability: NEXT_STEP_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { goal: fitJevText(goal.trim(), GOAL_BYTES), step: fitJevText(words, STEP_BYTES) },
    questions: {
      advances: {
        type: 'score',
        instructions: STEWARD_ADVANCE_QUESTION,
        criteria: STEWARD_ADVANCE_LEVELS
      }
    }
  }
}

export function readStewardAdvanceScore(result: DecisionResult): number | null {
  const answer = result.answers.advances
  return answer?.type === 'score' && Number.isFinite(answer.score) ? answer.score : null
}

export type StewardJev = {
  /** Why JEV cannot judge for the steward now; null when it can. */
  offReason(): string | null
  doneness(input: {
    source: ConversationSource
    turnKey: string
    reply: string
    lastUserPrompt?: string
  }): Promise<StewardDoneness | null>
  goal(source: ConversationSource): Promise<string | null>
  /** 0–4, or null when there is no reading. */
  advances(input: {
    turnKey: string
    goal: string
    step: NextStepSuggestion
  }): Promise<number | null>
}

export function createStewardJev(deps: {
  settings: () => NextStepSuggestionSettings
  nextStepJev: () => NextStepJev | null
  environment?: NodeJS.ProcessEnv
  jev?: JevRankOptions
}): StewardJev {
  const completions = new Map<string, Promise<StewardDoneness | null>>()
  const scores = new Map<string, Promise<number | null>>()
  const offReason = (): string | null =>
    jevUnavailableReason(deps.environment ?? process.env) ??
    (!nextStepJevSettings(deps.settings()).doneness
      ? 'JEV doneness readings are switched off in Settings'
      : !deps.nextStepJev()
        ? 'JEV is not running on this computer'
        : null)
  return {
    offReason,
    goal: async (source) => (await deps.nextStepJev()?.goalFor({ conversation: source })) ?? null,
    doneness: async ({ source, turnKey, reply, lastUserPrompt }) => {
      const jev = deps.nextStepJev()
      if (!jev || offReason()) {
        return null
      }
      const key = createHash('sha256')
        .update(JSON.stringify([source, turnKey, reply, lastUserPrompt]))
        .digest('hex')
      const existing = completions.get(key)
      if (existing) {
        return existing
      }
      const request = (async () => {
        const goal = await jev.goalFor({
          conversation: source,
          ...(lastUserPrompt ? { lastUserPrompt } : {})
        })
        const reading = goal
          ? await jev.assessDoneness({ conversation: source, turnKey, goal, replyTail: reply })
          : null
        return reading ? stewardDonenessOf(reading) : null
      })().catch(() => null)
      completions.set(key, request)
      if (completions.size > CACHE_MAX) {
        completions.delete(completions.keys().next().value!)
      }
      return request
    },
    advances: ({ turnKey, goal, step }) => {
      if (offReason()) {
        return Promise.resolve(null)
      }
      const key = `${turnKey}\u0000${step.id}`
      const known = scores.get(key)
      if (known) {
        return known
      }
      const jev = { ...deps.jev, caller: 'session-steward' }
      const asked = jevDecide(buildStewardAdvanceRequest(goal, step), jev).then((result) => {
        if ('failed' in result) {
          noteNextStepJevFailure('steward step check', result.failed)
          scores.delete(key)
          return null
        }
        return readStewardAdvanceScore(result)
      })
      scores.set(key, asked)
      if (scores.size > CACHE_MAX) {
        scores.delete(scores.keys().next().value!)
      }
      return asked
    }
  }
}
