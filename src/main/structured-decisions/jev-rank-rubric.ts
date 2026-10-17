import {
  DecisionProviderError,
  type DecisionRequest,
  type DecisionResult
} from '../../shared/structured-decisions'
import { JEV_SCORE_MARGIN } from '../../shared/jev-confidence'
import { JEV_DEFAULT_RUBRIC, jevCriteria, type JevCriterion } from '../../shared/jev-rubric'
import { TYPESAFE_DEFAULT_MODEL } from './typesafe-provider'
import {
  jevCertainties,
  jevCertaintyOf,
  jevUsageOf,
  type JevCertainty,
  type JevUsage
} from './jev-certainty'
import type { JevRankRequest, JevRanking } from './jev-rank'
import { fitJevText, jevPool, jevReadKey, JEV_RESPONSE_BYTES } from './jev-pool'

export { JEV_SCORE_MARGIN }
export {
  fitJevText,
  jevPool,
  jevReadKey,
  JEV_PAIR_RESPONSE_BYTES,
  JEV_RESPONSE_BYTES
} from './jev-pool'
export const JEV_SCORE_LEVELS = ['Fails the task', 'Weak', 'Adequate', 'Strong', 'Excellent']

type Ask = (request: DecisionRequest) => Promise<DecisionResult>

/** Ids by points, highest first; ties keep the given order. */
export function orderJevIds(ids: readonly string[], points: readonly number[]): string[] {
  return ids
    .map((id, index) => ({ id, index, points: points[index]! }))
    .sort((left, right) => right.points - left.points || left.index - right.index)
    .map((entry) => entry.id)
}

/** The overall score and one score per criterion, asked together in one request. */
export function jevRubricQuestions(
  criteria: readonly JevCriterion[]
): DecisionRequest['questions'] {
  const questions: DecisionRequest['questions'] = {
    quality: {
      type: 'score',
      instructions: 'How well does the response do what the task asks, judged by the rubric?',
      criteria: JEV_SCORE_LEVELS
    }
  }
  for (const criterion of criteria) {
    questions[criterion.id] = {
      type: 'score',
      instructions: criterion.question,
      criteria: JEV_SCORE_LEVELS
    }
  }
  return questions
}

const scoreOf = (result: DecisionResult, id: string): number => {
  const answer = result.answers[id]
  if (answer?.type !== 'score') {
    throw new DecisionProviderError('invalid_response')
  }
  return answer.score
}

/** Multi-fidelity rubric cascade: when 2+ unique candidates and 5+ criteria (or `cascade: true`) are scored, screen on `quality` + first 35% of criteria first and prune candidates trailing the screen leader by more than `JEV_CASCADE_MARGIN`. */
export const JEV_CASCADE_FRACTION = 0.35
export const JEV_CASCADE_MARGIN = 0.15

/** Unsure when the top two overall scores are closer than `margin` (0–4). */
export async function rankJevByRubric(
  request: JevRankRequest & { cascade?: boolean },
  ask: Ask,
  margin: number = JEV_SCORE_MARGIN
): Promise<JevRanking> {
  const rubric = fitJevText(request.rubric.trim() || JEV_DEFAULT_RUBRIC, 6_000)
  const task = fitJevText(request.task, 6_000)
  const criteria = jevCriteria(request.rubric)
  // Identical candidates share one evaluation.
  const keys = request.candidates.map((candidate) => jevReadKey(candidate.text))
  const unique = [...new Set(keys)]
  const useCascade =
    unique.length > 1 &&
    request.cascade !== false &&
    (request.cascade === true ? criteria.length >= 2 : criteria.length >= 6)
  const screenCount = useCascade
    ? Math.max(1, Math.ceil(criteria.length * JEV_CASCADE_FRACTION))
    : criteria.length
  const screenCriteria = criteria.slice(0, screenCount)
  const restCriteria = criteria.slice(screenCount)
  const phase1Questions = jevRubricQuestions(screenCriteria)
  const phase1Answers = await jevPool(unique, (key) =>
    ask({
      capability: request.capability ?? 'workflow.judge',
      model: TYPESAFE_DEFAULT_MODEL,
      state: {
        task,
        rubric,
        response: fitJevText(request.candidates[keys.indexOf(key)]!.text, JEV_RESPONSE_BYTES)
      },
      questions: phase1Questions
    })
  )
  const allResults: DecisionResult[] = [...phase1Answers]
  const uniqueAnswers = [...phase1Answers]
  if (restCriteria.length > 0) {
    const screenScores = phase1Answers.map((result) => {
      const sum =
        scoreOf(result, 'quality') +
        screenCriteria.reduce((acc, c) => acc + scoreOf(result, c.id), 0)
      return sum / (1 + screenCriteria.length)
    })
    const bestScreen = Math.max(...screenScores)
    // Normalized 0..1 scale margin (JEV_CASCADE_MARGIN = 0.15 -> 0.60 on 0..4 scale).
    const cutoff = bestScreen - JEV_CASCADE_MARGIN * (JEV_SCORE_LEVELS.length - 1)
    const survivorIndices = unique
      .map((_, index) => index)
      .filter((index) => screenScores[index]! >= cutoff)
    const phase2Questions: DecisionRequest['questions'] = {}
    for (const criterion of restCriteria) {
      phase2Questions[criterion.id] = {
        type: 'score',
        instructions: criterion.question,
        criteria: JEV_SCORE_LEVELS
      }
    }
    const phase2Answers = await jevPool(survivorIndices, (uniqueIndex) => {
      const key = unique[uniqueIndex]!
      return ask({
        capability: request.capability ?? 'workflow.judge',
        model: TYPESAFE_DEFAULT_MODEL,
        state: {
          task,
          rubric,
          response: fitJevText(request.candidates[keys.indexOf(key)]!.text, JEV_RESPONSE_BYTES)
        },
        questions: phase2Questions
      })
    })
    allResults.push(...phase2Answers)
    survivorIndices.forEach((uniqueIndex, i) => {
      const p1 = uniqueAnswers[uniqueIndex]!
      const p2 = phase2Answers[i]!
      uniqueAnswers[uniqueIndex] = {
        ...p1,
        answers: { ...p1.answers, ...p2.answers }
      }
    })
  }
  const answers = keys.map((key) => uniqueAnswers[unique.indexOf(key)]!)
  const ids = request.candidates.map((candidate) => candidate.id)
  const overall = answers.map((result) => scoreOf(result, 'quality'))
  const order = orderJevIds(ids, overall)
  const gap =
    ids.length > 1
      ? overall[ids.indexOf(order[0])]! - overall[ids.indexOf(order[1])]!
      : Number.POSITIVE_INFINITY
  const unsure = gap < margin
  const certainty = (id: string) =>
    jevCertainties(ids.map((option, index) => [option, jevCertaintyOf(answers[index]!, id)]))
  const overallCertainty = certainty('quality')
  const usage = jevUsageOf(allResults)
  return {
    method: 'rubric',
    model: TYPESAFE_DEFAULT_MODEL,
    order,
    scores: Object.fromEntries(ids.map((id, index) => [id, overall[index]!])),
    ...(overallCertainty ? { certainty: overallCertainty } : {}),
    criteria: criteria.map((criterion) => {
      const criterionCertainty = certainty(criterion.id)
      const scoredEntries = ids
        .map((id, index) => {
          const ans = answers[index]!.answers[criterion.id]
          return ans?.type === 'score' ? ([id, ans.score] as const) : undefined
        })
        .filter((entry): entry is readonly [string, number] => !!entry)
      return {
        id: criterion.id,
        label: criterion.label,
        scores: Object.fromEntries(scoredEntries),
        ...(criterionCertainty ? { certainty: criterionCertainty } : {})
      }
    }),
    ...(usage ? { usage } : {}),
    unsure,
    ...(unsure
      ? {
          unsureReason: `the top two scores are ${gap.toFixed(2)} apart (less than ${margin})`
        }
      : {}),
    calls: allResults.length
  }
}

export type JevScreenRequest = {
  task: string
  rubric: string
  candidates: { id: string; text: string }[]
  capability?: string
}

/** A pool scored against a rubric: 0–4 overall and on every criterion, per option JEV scored. */
export type JevScreen = {
  model: string
  scores: Record<string, number>
  /** JEV's confidence and level probabilities per scored option, when its answers carried them. */
  certainty?: Record<string, JevCertainty>
  criteria: {
    id: string
    label: string
    scores: Record<string, number>
    certainty?: Record<string, JevCertainty>
  }[]
  /** Options JEV could not score after a retry: left out and named, never guessed. */
  unscored: string[]
  /** Of `unscored`, the ones that failed for a transient reason (rate limit, overload, network):
   * never cached as a real failure, so a later Retry asks the provider for these again. */
  retryableUnscored: string[]
  /** Why JEV could not score each of `unscored`, when any. */
  unscoredReasons?: Record<string, string>
  /** The last reason a request failed, when any did. */
  lastError?: string
  /** Whether that last reason is transient (rate limit, overload, network): safe to just retry. */
  lastErrorRetryable?: boolean
  usage?: JevUsage
  calls: number
}

/**
 * Scores many options against a rubric, one request per option. Unlike a ranking, one failed
 * request does not void the rest: it is retried once, and an option still unscored is named.
 */
export async function screenJevByRubric(request: JevScreenRequest, ask: Ask): Promise<JevScreen> {
  const rubric = fitJevText(request.rubric.trim() || JEV_DEFAULT_RUBRIC, 6_000)
  const task = fitJevText(request.task, 6_000)
  const criteria = jevCriteria(request.rubric)
  const questions = jevRubricQuestions(criteria)
  let calls = 0
  let lastError: string | undefined
  let lastErrorRetryable = false
  // A run cannot sit still for a provider's own cooldown past this; honour Retry-After up to
  // here, and never retry a wait it does not name before this deadline has passed either.
  const MAX_RETRY_WAIT_MS = 10_000
  const perCandidateRetryable: (boolean | undefined)[] = []
  const perCandidateError: string[] = []
  const results = await jevPool(request.candidates, async (candidate, index) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++
      try {
        const result = await ask({
          capability: request.capability ?? 'workflow.judge',
          model: TYPESAFE_DEFAULT_MODEL,
          state: { task, rubric, response: fitJevText(candidate.text, JEV_RESPONSE_BYTES) },
          questions
        })
        return {
          overall: scoreOf(result, 'quality'),
          criteria: criteria.map((criterion) => scoreOf(result, criterion.id)),
          result
        }
      } catch (error) {
        lastError = error instanceof DecisionProviderError ? error.code : String(error)
        lastErrorRetryable = error instanceof DecisionProviderError ? error.retryable : false
        perCandidateRetryable[index] = lastErrorRetryable
        perCandidateError[index] =
          error instanceof DecisionProviderError ? `JEV answered ${error.code}` : String(error)
        if (attempt === 0 && lastErrorRetryable) {
          const retryAfterMs =
            error instanceof DecisionProviderError ? error.retryAfterMs : undefined
          if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_WAIT_MS) {
            // The provider asked for longer than this run can wait: fail now, retryable, so the
            // caller can try again later rather than stalling here past its deadline.
            break
          }
          await new Promise((resolve) => setTimeout(resolve, retryAfterMs ?? 250))
        }
      }
    }
    return undefined
  })
  const scored = request.candidates.flatMap((candidate, index) => {
    const result = results[index]
    return result ? [{ id: candidate.id, ...result }] : []
  })
  const certainty = (id: string) =>
    jevCertainties(scored.map((entry) => [entry.id, jevCertaintyOf(entry.result, id)]))
  const overallCertainty = certainty('quality')
  const usage = jevUsageOf(results.map((entry) => entry?.result))
  const unscored = request.candidates.filter((_, index) => !results[index])
  return {
    model: TYPESAFE_DEFAULT_MODEL,
    scores: Object.fromEntries(scored.map((entry) => [entry.id, entry.overall])),
    ...(overallCertainty ? { certainty: overallCertainty } : {}),
    criteria: criteria.map((criterion, index) => {
      const criterionCertainty = certainty(criterion.id)
      return {
        id: criterion.id,
        label: criterion.label,
        scores: Object.fromEntries(scored.map((entry) => [entry.id, entry.criteria[index]!])),
        ...(criterionCertainty ? { certainty: criterionCertainty } : {})
      }
    }),
    ...(usage ? { usage } : {}),
    unscored: unscored.map((candidate) => candidate.id),
    ...(unscored.length
      ? {
          unscoredReasons: Object.fromEntries(
            unscored.map((candidate) => [
              candidate.id,
              perCandidateError[request.candidates.indexOf(candidate)] ?? 'JEV gave no score'
            ])
          )
        }
      : {}),
    retryableUnscored: request.candidates
      .filter((_, index) => !results[index] && perCandidateRetryable[index])
      .map((candidate) => candidate.id),
    ...(lastError ? { lastError, lastErrorRetryable } : {}),
    calls
  }
}
