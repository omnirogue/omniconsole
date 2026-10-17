import {
  DecisionProviderError,
  decisionIdentifierSchema,
  type DecisionAnswer,
  type DecisionRequest,
  type DecisionResult
} from './structured-decision-contract'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
// Providers round each probability to two decimals, so sums drift by up to this much per option.
const ROUNDING = 0.005
const EPSILON = 1e-9

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
// A distribution of `options` rounded values may miss 1 by up to one rounding per option.
export function roundedSumIsOne(sum: number, options: number): boolean {
  return Math.abs(sum - 1) <= Math.max(0.001, ROUNDING * options) + EPSILON
}
// Rounding moves each of two values by up to 0.005, so the chosen option may trail another
// by up to 0.01 once rounded. JEV returned 0.37 against 0.38 in live session classification.
export function mayBeRoundedMaximum(
  probabilities: Record<string, number>,
  choice: string
): boolean {
  const ceiling = probabilities[choice]! + 2 * ROUNDING + EPSILON
  return Object.values(probabilities).every((p) => p <= ceiling)
}
function distribution(value: unknown, keys: string[]): value is Record<string, number> {
  if (!record(value) || !exactKeys(value, keys) || !Object.values(value).every(probability)) {
    return false
  }
  const sum = Object.values(value).reduce<number>((total, p) => total + (p as number), 0)
  return roundedSumIsOne(sum, keys.length)
}
function invalidResponse(): never {
  throw new DecisionProviderError('invalid_response')
}

export function validateDecisionResult(
  result: DecisionResult,
  request: DecisionRequest
): DecisionResult {
  if (
    !record(result) ||
    !decisionIdentifierSchema.safeParse(result.provider).success ||
    !decisionIdentifierSchema.safeParse(result.model).success ||
    !record(result.answers) ||
    !exactKeys(result.answers, Object.keys(request.questions))
  ) {
    invalidResponse()
  }
  if (
    !record(result.usage) ||
    ![result.usage.inputTokens, result.usage.outputTokens].every(
      (n) => Number.isSafeInteger(n) && (n as number) >= 0
    )
  ) {
    invalidResponse()
  }
  if (
    result.requestId !== undefined &&
    !decisionIdentifierSchema.safeParse(result.requestId).success
  ) {
    invalidResponse()
  }
  const answers: Record<string, DecisionAnswer> = Object.create(null)
  for (const [id, question] of Object.entries(request.questions)) {
    const answer: unknown = result.answers[id]
    if (!record(answer) || answer.type !== question.type) {
      invalidResponse()
    }
    if (question.type === 'noul') {
      if (!probability(answer.noul)) {
        invalidResponse()
      }
      answers[id] = { type: 'noul', noul: answer.noul }
      continue
    }
    const keys =
      question.type === 'choice'
        ? Object.keys(question.criteria)
        : question.criteria.map((_, index) => String(index))
    const probabilities = answer.probabilities
    const confidence = answer.confidence
    if (!distribution(probabilities, keys) || !probability(confidence)) {
      invalidResponse()
    }
    if (question.type === 'choice') {
      const choice = answer.choice
      if (
        typeof choice !== 'string' ||
        !keys.includes(choice) ||
        !mayBeRoundedMaximum(probabilities, choice)
      ) {
        invalidResponse()
      }
      answers[id] = { type: 'choice', choice, probabilities: { ...probabilities }, confidence }
    } else {
      const legend = answer.legend
      if (
        !record(legend) ||
        !exactKeys(legend, keys) ||
        keys.some(
          (key) => JSON.stringify(legend[key]) !== JSON.stringify(question.criteria[Number(key)])
        )
      ) {
        invalidResponse()
      }
      const expected = keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0)
      const drift = ROUNDING * keys.reduce((sum, key) => sum + Number(key), 0)
      if (
        typeof answer.score !== 'number' ||
        !Number.isFinite(answer.score) ||
        answer.score < 0 ||
        answer.score > keys.length - 1 ||
        Math.abs(answer.score - expected) > 0.02 + drift + EPSILON
      ) {
        invalidResponse()
      }
      answers[id] = {
        type: 'score',
        score: answer.score,
        legend: Object.fromEntries(keys.map((key) => [key, question.criteria[Number(key)]])),
        probabilities: { ...probabilities },
        confidence
      }
    }
  }
  return {
    provider: result.provider,
    model: result.model,
    answers,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    ...(result.requestId ? { requestId: result.requestId } : {})
  }
}
