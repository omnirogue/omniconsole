/**
 * JEV's questions behind re-titling (Phase 3 §2): does the latest finished turn still serve the
 * session's goal (a drift reading), and which candidate title names the work now, or keep the
 * current one. A failed or missing answer changes nothing.
 */

import type { DecisionRequest, DecisionResult } from '../../../shared/structured-decisions'
import { fitJevText } from '../../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../../structured-decisions/typesafe-provider'
import { STEWARD_ORGANIZE_JEV_CAPABILITY, type StewardJevDecide } from './steward-organize-jev'

export const STEWARD_ON_GOAL_QUESTION =
  "Does the second (the session's latest finished turn) still work toward the first (the goal the person gave the session)?"

export const STEWARD_TITLE_QUESTION =
  'Which title best names what this session is working on now? Pick "keep" when the current title still fits.'

export const STEWARD_KEEP_TITLE = 'keep'
/** A title other than the current one needs this much of JEV's confidence. */
export const STEWARD_TITLE_MIN = 0.6

/** How well the latest turn still serves the goal; null when JEV did not answer. */
export async function readStillOnGoal(
  goal: string,
  turn: string,
  decide: StewardJevDecide
): Promise<number | null> {
  const request: DecisionRequest = {
    capability: STEWARD_ORGANIZE_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: { first: fitJevText(goal, 4_000), second: fitJevText(turn, 8_000) },
    questions: { onGoal: { type: 'noul', instructions: STEWARD_ON_GOAL_QUESTION } }
  }
  const result: DecisionResult | { failed: string } = await decide(request)
  if ('failed' in result) {
    return null
  }
  const answer = result.answers.onGoal
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : null
}

export type StewardTitleChoice = { title: string | null; confidence: number } | { failed: string }

/** JEV's pick among the candidates or "keep"; `title: null` keeps the current one. */
export async function chooseStewardTitle(
  input: {
    current: string
    candidates: readonly string[]
    goal: string | null
    instruction: string | null
    turn: string | null
  },
  decide: StewardJevDecide
): Promise<StewardTitleChoice> {
  const criteria: Record<string, string> = { [STEWARD_KEEP_TITLE]: input.current }
  input.candidates.forEach((candidate, index) => {
    criteria[`t${index}`] = candidate
  })
  const result = await decide({
    capability: STEWARD_ORGANIZE_JEV_CAPABILITY,
    model: TYPESAFE_DEFAULT_MODEL,
    state: {
      currentTitle: input.current,
      goal: fitJevText(input.goal ?? 'unknown', 2_000),
      latestInstruction: fitJevText(input.instruction ?? 'unknown', 2_000),
      latestTurn: fitJevText(input.turn ?? 'unknown', 4_000)
    },
    questions: { title: { type: 'choice', instructions: STEWARD_TITLE_QUESTION, criteria } }
  })
  if ('failed' in result) {
    return result
  }
  const answer = result.answers.title
  if (answer?.type !== 'choice') {
    return { failed: 'JEV did not answer the title question' }
  }
  const confidence = answer.probabilities[answer.choice] ?? answer.confidence
  if (answer.choice === STEWARD_KEEP_TITLE) {
    return { title: null, confidence }
  }
  const index = /^t(\d+)$/.exec(answer.choice)?.[1]
  const title = index === undefined ? undefined : input.candidates[Number(index)]
  return title ? { title, confidence } : { failed: `JEV chose an unknown title (${answer.choice})` }
}
