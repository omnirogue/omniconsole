/**
 * JEV's pass over one suggestion set: four yes/no criteria per step (ranking) and one risk
 * question per step, all in ONE request. JEV advises: an unsure or failed reading keeps the
 * writer's order, and a risk reading can only ever raise a step to risky.
 */

import { nextStepDonenessIsUnsure } from '../../shared/next-step-doneness'
import type { NextStepSuggestion, NextStepSuggestionSet } from '../../shared/next-step-suggestions'
import type { DecisionRequest, DecisionResult } from '../../shared/structured-decisions'
import { JEV_SCORE_MARGIN, jevDecide, type JevRankOptions } from '../structured-decisions/jev-rank'
import { fitJevText } from '../structured-decisions/jev-rank-rubric'
import { TYPESAFE_DEFAULT_MODEL } from '../structured-decisions/typesafe-provider'

export const NEXT_STEP_JEV_CAPABILITY = 'next-steps.judge'
/** A clear yes: at or above this, JEV raises a step to risky. */
export const NEXT_STEP_JEV_RISK_RAISE = 0.8
/** Top-two scores closer than this (0–1) are not a ranking: JEV's 0.5-of-4 rubric margin. */
export const NEXT_STEP_JEV_RANK_MARGIN = JEV_SCORE_MARGIN / 4
/** The request stays under the 64 KiB input limit with room for JSON escaping. */
export const NEXT_STEP_JEV_MAX_REQUEST_BYTES = 60_000
const TURN_BYTES = 20_000
const STEP_BYTES = 3_000

export const NEXT_STEP_JEV_CRITERIA = [
  {
    id: 'valuable',
    question: "Would doing {step} be valuable for the person's goal, as the turn shows it?"
  },
  {
    id: 'specific',
    question:
      'Is {step} specific and actionable, so the agent could start on it without asking what is meant?'
  },
  {
    id: 'grounded',
    question:
      'Is {step} grounded in what actually happened in the turn, with no invented files, names, numbers or results?'
  },
  { id: 'not_done', question: 'Is {step} work the turn has NOT already done?' }
] as const

export const NEXT_STEP_JEV_RISK_QUESTION =
  'Would running {step} leave the workspace, destroy data outside git, touch credentials or permissions, contact people, or spend money?'

export type NextStepJudgeInput = {
  /** The fenced turn text the suggester saw (`nextStepTranscriptBlock`). */
  turnText: string
  suggestions: readonly NextStepSuggestion[]
  rank: boolean
  risk: boolean
}

export type NextStepJudgement = {
  suggestions: NextStepSuggestion[]
} & Pick<NextStepSuggestionSet, 'rankedBy' | 'jevScores'>

const stepKey = (index: number): string => `step_${index + 1}`

function stepText(suggestion: NextStepSuggestion): string {
  return fitJevText(
    [
      `Title: ${suggestion.title}`,
      `Prompt: ${suggestion.prompt}`,
      ...(suggestion.why ? [`Why: ${suggestion.why}`] : [])
    ].join('\n'),
    STEP_BYTES
  )
}

function questionsFor(input: NextStepJudgeInput): DecisionRequest['questions'] {
  const questions: DecisionRequest['questions'] = {}
  input.suggestions.forEach((_, index) => {
    const step = `step ${index + 1} (steps.${stepKey(index)})`
    if (input.rank) {
      for (const criterion of NEXT_STEP_JEV_CRITERIA) {
        questions[`${stepKey(index)}.${criterion.id}`] = {
          type: 'noul',
          instructions: criterion.question.replace('{step}', step)
        }
      }
    }
    if (input.risk) {
      questions[`${stepKey(index)}.risk`] = {
        type: 'noul',
        instructions: NEXT_STEP_JEV_RISK_QUESTION.replace('{step}', step)
      }
    }
  })
  return questions
}

const requestBytes = (request: DecisionRequest): number =>
  new TextEncoder().encode(JSON.stringify(request)).byteLength

/** One request for the whole set, cut to fit: the turn text gives way first. */
export function buildNextStepJudgeRequest(input: NextStepJudgeInput): DecisionRequest {
  const steps = Object.fromEntries(
    input.suggestions.map((suggestion, index) => [stepKey(index), stepText(suggestion)])
  )
  const questions = questionsFor(input)
  let budget = TURN_BYTES
  for (;;) {
    const request: DecisionRequest = {
      capability: NEXT_STEP_JEV_CAPABILITY,
      model: TYPESAFE_DEFAULT_MODEL,
      state: { turn: fitJevText(input.turnText, budget), steps },
      questions
    }
    const over = requestBytes(request) - NEXT_STEP_JEV_MAX_REQUEST_BYTES
    if (over <= 0 || budget <= 1_000) {
      return request
    }
    budget = Math.max(1_000, budget - over - 500)
  }
}

function yesOf(result: DecisionResult, id: string): number | undefined {
  const answer = result.answers[id]
  return answer?.type === 'noul' && Number.isFinite(answer.noul) ? answer.noul : undefined
}

const hundredths = (value: number): number => Math.round(value * 100) / 100

/**
 * Unrounded scores per step, or null when any step lacks a reading (a partial ranking decides
 * nothing). `clear` is false when any reading sits in JEV's unsure band.
 */
function scoresOf(
  input: NextStepJudgeInput,
  result: DecisionResult
): { scores: number[]; clear: boolean } | null {
  const scores: number[] = []
  let clear = true
  for (let index = 0; index < input.suggestions.length; index++) {
    const readings = NEXT_STEP_JEV_CRITERIA.map((criterion) =>
      yesOf(result, `${stepKey(index)}.${criterion.id}`)
    )
    if (readings.some((reading) => reading === undefined)) {
      return null
    }
    clear &&= !readings.some((reading) => nextStepDonenessIsUnsure(reading!))
    scores.push(readings.reduce<number>((total, reading) => total + reading!, 0) / readings.length)
  }
  return { scores, clear }
}

/** Best first, ties in the writer's order; null when the top two are too close to call. */
function clearOrder(scores: readonly number[]): number[] | null {
  const order = scores
    .map((score, index) => ({ score, index }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.index)
  if (order.length < 2) {
    return order
  }
  const gap = scores[order[0]!]! - scores[order[1]!]!
  return gap >= NEXT_STEP_JEV_RANK_MARGIN - 1e-9 ? order : null
}

/** Applies JEV's answers (null = no answer): reorder only when sure, raise risk only on a clear yes. */
export function applyNextStepJudgement(
  input: NextStepJudgeInput,
  result: DecisionResult | null
): NextStepJudgement {
  const raised = input.suggestions.map((suggestion, index): NextStepSuggestion => {
    const risk = input.risk && result ? yesOf(result, `${stepKey(index)}.risk`) : undefined
    if (risk === undefined) {
      return suggestion
    }
    // Only a clear yes raises; the unsure band and every no change nothing.
    const clearYes = risk >= NEXT_STEP_JEV_RISK_RAISE
    return {
      ...suggestion,
      jevRisk: hundredths(risk),
      ...(clearYes && suggestion.risk === 'safe'
        ? { risk: 'risky' as const, riskReason: 'jev' as const }
        : {})
    }
  })
  if (!input.rank) {
    return { suggestions: raised }
  }
  const read = result ? scoresOf(input, result) : null
  if (!read) {
    return { suggestions: raised, rankedBy: 'model' }
  }
  const { scores, clear } = read
  const jevScores = Object.fromEntries(
    raised.map((step, index) => [step.id, hundredths(scores[index]!)])
  )
  // An unsure reading never reorders; the margin is judged on unrounded scores.
  const order = clear ? clearOrder(scores) : null
  return order
    ? { suggestions: order.map((index) => raised[index]!), rankedBy: 'jev', jevScores }
    : { suggestions: raised, rankedBy: 'model', jevScores }
}

const reportedFailures = new Set<string>()

/** Logs each distinct reason once per process: an unavailable JEV must not spam the log. */
export function noteNextStepJevFailure(what: string, reason: string): void {
  const key = `${what}: ${reason}`
  if (reportedFailures.size < 100 && !reportedFailures.has(key)) {
    reportedFailures.add(key)
    console.info(`[next-steps] JEV ${key}; kept the suggester's own reading.`)
  }
}

/** One JEV call per set; with JEV off, unavailable or failing, the set comes back as it was. */
export async function judgeNextStepSuggestions(
  input: NextStepJudgeInput,
  options: JevRankOptions = {}
): Promise<NextStepJudgement> {
  if (!input.suggestions.length || (!input.rank && !input.risk)) {
    return { suggestions: [...input.suggestions] }
  }
  const result = await jevDecide(buildNextStepJudgeRequest(input), options)
  if ('failed' in result) {
    noteNextStepJevFailure('ranking', result.failed)
    return applyNextStepJudgement(input, null)
  }
  return applyNextStepJudgement(input, result)
}
