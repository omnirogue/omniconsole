import { compareImproveMeasure, improveCheckMeasure } from './graph-improve-check'
import type { ImproveVersion } from './graph-improve-decide'
import type { GraphImproveRound } from './graph-plan-types'

/**
 * Improve rules 2 with a check: progress is the best version's check measure strictly improving
 * (passing where it failed, more practice cases passed, or a higher score). A win the judges
 * alone decided still replaces the best version, but it is not progress: patience runs on.
 */
export function improveMeasuredProgress(
  before: ImproveVersion | undefined,
  after: ImproveVersion | undefined
): boolean {
  return (
    !!before &&
    !!after &&
    compareImproveMeasure(improveCheckMeasure(after.check), improveCheckMeasure(before.check)) > 0
  )
}

/**
 * Stop `passing-kept`: the best version passes every practice case, and the judges, with a
 * counted vote, kept it over every new version the check could not rank below it.
 */
export function improvePassingKept(
  entry: GraphImproveRound,
  best: ImproveVersion | undefined
): boolean {
  const check = best?.check
  return (
    !!check?.passed &&
    !!check.cases?.total &&
    entry.result === 'kept' &&
    entry.judgedBy.some((who) => who === 'jev' || who === 'models')
  )
}
