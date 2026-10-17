import { graphPredictionKept } from './graph-check-prediction'
import { compareImproveMeasure, improveCheckMeasure } from './graph-improve-check'
import type { GraphImproveRole } from './graph-plan-types'
import type { ImproveVersion } from './graph-improve-decide'

/**
 * A version improvers build on: the best, one kept because it passes practice cases the best
 * fails, or (when no version does) the strongest losing version that took a different line.
 */
export type ImproveParent = { version: ImproveVersion; kept: 'best' | 'cases' | 'alternative' }

/** Earlier round first, then the lower improver: one order every replay and projection sees. */
function byOrigin(left: ImproveVersion, right: ImproveVersion): number {
  return left.round - right.round || left.text.agentIndex - right.text.agentIndex
}

function passingOf(version: ImproveVersion): number[] | undefined {
  return version.check && !version.check.unavailable ? version.check.cases?.passing : undefined
}

/**
 * The versions to build on next round, the best first. The rest are chosen by measured
 * diversity, lexicase style: each one must pass a practice case that neither the best nor any
 * version chosen before it passes. More such cases come first, then the better check result,
 * then (round, improver). With no such version, the strongest alternative is kept instead.
 * "No change" is never kept beside the best: every improver already starts from the code as it is.
 */
export function improveArchive(input: {
  best: ImproveVersion
  pool: readonly ImproveVersion[]
  alternative?: ImproveVersion
  population: number
}): ImproveParent[] {
  const { best, population } = input
  const archive: ImproveParent[] = [{ version: best, kept: 'best' }]
  if (population <= 1) {
    return archive
  }
  const total = best.check?.cases?.total
  const seen = new Set([best.text.callId])
  const pool = input.pool.filter((version) => {
    const fresh = !seen.has(version.text.callId)
    seen.add(version.text.callId)
    return (
      fresh &&
      version.round > 0 &&
      graphPredictionKept(version.prediction) &&
      !!passingOf(version) &&
      version.check?.cases?.total === total
    )
  })
  const covered = new Set(passingOf(best) ?? [])
  while (archive.length < population) {
    const ranked = pool
      .filter((version) => !archive.some((member) => member.version === version))
      .map((version) => ({
        version,
        gain: passingOf(version)!.filter((index) => !covered.has(index)).length
      }))
      .filter((entry) => entry.gain > 0)
      .sort(
        (left, right) =>
          right.gain - left.gain ||
          compareImproveMeasure(
            improveCheckMeasure(right.version.check),
            improveCheckMeasure(left.version.check)
          ) ||
          byOrigin(left.version, right.version)
      )
    const next = ranked[0]?.version
    if (!next) {
      break
    }
    archive.push({ version: next, kept: 'cases' })
    for (const index of passingOf(next)!) {
      covered.add(index)
    }
  }
  const alternative = input.alternative
  if (
    archive.length === 1 &&
    alternative &&
    graphPredictionKept(alternative.prediction) &&
    alternative.round > 0 &&
    alternative.text.callId !== best.text.callId
  ) {
    archive.push({ version: alternative, kept: 'alternative' })
  }
  return archive
}

/**
 * The archive after a round: chosen again from what was kept, the best going in and the round's
 * new versions, so a kept version stays only while it still passes a case no other one does.
 */
export function improveNextArchive(input: {
  before: { best?: ImproveVersion; archive?: ImproveParent[] }
  after: { best?: ImproveVersion; alternative?: ImproveVersion }
  challengers: readonly ImproveVersion[]
  population: number
}): ImproveParent[] | undefined {
  const { before, after, population } = input
  if (population <= 1 || !after.best) {
    return undefined
  }
  const pool = [
    ...(before.archive ?? []).map((member) => member.version),
    ...(before.best ? [before.best] : []),
    ...input.challengers
  ]
  return improveArchive({
    best: after.best,
    pool,
    ...(after.alternative ? { alternative: after.alternative } : {}),
    population
  })
}

/** Improver `index` builds on `archive[index % k]`; with one version to build on, on the best. */
export function improveParents(
  carry: { best?: ImproveVersion; archive?: ImproveParent[] },
  population: number,
  count: number
): (ImproveParent | undefined)[] {
  const archive =
    carry.archive ?? (carry.best ? [{ version: carry.best, kept: 'best' as const }] : [])
  return Array.from({ length: count }, (_, index) =>
    population > 1 && archive.length ? archive[index % archive.length] : undefined
  )
}

/** A first version is not asked for when an improver is handed a kept version to build on. */
export function improveParentRole(
  role: GraphImproveRole,
  parent: ImproveParent | undefined
): GraphImproveRole {
  return role === 'first' && parent && parent.kept !== 'best' ? 'improve' : role
}
