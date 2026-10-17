/**
 * "Push for better": did the latest round clearly improve on the one before? JEV is asked in both
 * orders (the latest shown second, then first), so the position it is shown in cannot decide.
 */

import {
  nextStepDonenessIsUnsure,
  type NextStepImprovementVerdict
} from '../../shared/next-step-doneness'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { jevDecide, type JevRankOptions } from '../structured-decisions/jev-rank'
import { fitJevText } from '../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../structured-decisions/typesafe-provider'
import { NEXT_STEP_JEV_CAPABILITY, noteNextStepJevFailure } from './next-step-jev-rank'

export type NextStepImprovementInput = {
  goal: string
  pushPrompt: string
  /** The reply tail before this round, and this round's. */
  previous: string
  latest: string
}

export const NEXT_STEP_IMPROVEMENT_QUESTIONS = {
  latestSecond:
    'Given the goal and the push prompt, is version B clearly better than version A (not just different or longer)?',
  latestFirst:
    'Given the goal and the push prompt, is version A clearly better than version B (not just different or longer)?'
} as const

function request(input: NextStepImprovementInput, latestShownFirst: boolean): DecisionRequest {
  const [a, b] = latestShownFirst ? [input.latest, input.previous] : [input.previous, input.latest]
  return {
    capability: NEXT_STEP_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: {
      goal: fitJevText(input.goal.trim(), 6_000),
      push_prompt: fitJevText(input.pushPrompt.trim(), 4_000),
      version_a: fitJevText(a, 24_000),
      version_b: fitJevText(b, 24_000)
    },
    questions: {
      latest_better: {
        type: 'noul',
        instructions: latestShownFirst
          ? NEXT_STEP_IMPROVEMENT_QUESTIONS.latestFirst
          : NEXT_STEP_IMPROVEMENT_QUESTIONS.latestSecond
      }
    }
  }
}

const yesOf = (result: DecisionResult | { failed: string }): number | undefined => {
  if ('failed' in result) {
    noteNextStepJevFailure('improvement', result.failed)
    return undefined
  }
  const answer = result.answers.latest_better
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : undefined
}

/**
 * Both orders, averaged (unrounded). Unsure unless each order's reading is clear on its own and
 * both fall on the same side of 0.5. Null when JEV is off, unavailable or failed.
 */
export async function judgeNextStepImprovement(
  input: NextStepImprovementInput,
  options: JevRankOptions = {}
): Promise<NextStepImprovementVerdict | null> {
  if (!input.previous.trim() || !input.latest.trim()) {
    return null
  }
  const [second, first] = (
    await Promise.all([
      jevDecide(request(input, false), { ...options, caller: 'next-steps.improvement' }),
      jevDecide(request(input, true), { ...options, caller: 'next-steps.improvement' })
    ])
  ).map(yesOf)
  if (second === undefined || first === undefined) {
    return null
  }
  return {
    improved: (second + first) / 2,
    unsure:
      nextStepDonenessIsUnsure(second) ||
      nextStepDonenessIsUnsure(first) ||
      second >= 0.5 !== first >= 0.5
  }
}
