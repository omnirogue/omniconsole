import type { DecisionResult } from '../../shared/structured-decisions'

/**
 * How sure JEV was of one score, kept beside the score so a calibration report can later compare
 * JEV's stated certainty with how often it was right. Absent when the answer carried none.
 */
export type JevCertainty = {
  /** JEV's own confidence in the answer, 0–1. */
  confidence: number
  /** Probability of each score level, lowest level first. */
  levels: number[]
}

/** One head-to-head judgment: how likely JEV found `first` better when it was shown first. */
export type JevPairJudgment = { first: string; second: string; probability: number }

export type JevUsage = { inputTokens: number; outputTokens: number }

export function jevCertaintyOf(result: DecisionResult, id: string): JevCertainty | undefined {
  const answer = result.answers[id]
  if (answer?.type !== 'score' || !Object.keys(answer.probabilities).length) {
    return undefined
  }
  const levels = Object.keys(answer.legend).length || Object.keys(answer.probabilities).length
  return {
    confidence: answer.confidence,
    levels: Array.from({ length: levels }, (_, level) => answer.probabilities[String(level)] ?? 0)
  }
}

/** Tokens over every answered request; undefined when none reported any. */
export function jevUsageOf(results: readonly (DecisionResult | undefined)[]): JevUsage | undefined {
  const reported = results.filter((result): result is DecisionResult => !!result?.usage)
  return reported.length
    ? reported.reduce(
        (sum, result) => ({
          inputTokens: sum.inputTokens + result.usage.inputTokens,
          outputTokens: sum.outputTokens + result.usage.outputTokens
        }),
        { inputTokens: 0, outputTokens: 0 }
      )
    : undefined
}

/** Certainties by option id, or undefined when no answer carried one. */
export function jevCertainties(
  entries: readonly [string, JevCertainty | undefined][]
): Record<string, JevCertainty> | undefined {
  const kept = entries.filter((entry): entry is [string, JevCertainty] => !!entry[1])
  return kept.length ? Object.fromEntries(kept) : undefined
}
