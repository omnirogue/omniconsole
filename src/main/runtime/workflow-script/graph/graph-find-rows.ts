import { findJudgeText } from '../../../../shared/find-judge-text'
import type { WorkflowFindRow, WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { FindOption } from './graph-find-pool'
import type { GraphCheckResult, GraphOutcome } from './graph-plan-types'

const rowCheck = (check: GraphCheckResult): NonNullable<WorkflowFindRow['check']> => ({
  passed: check.passed,
  ...(check.score !== undefined ? { score: check.score } : {}),
  ...(check.unavailable ? { unavailable: true as const } : {})
})

export type FindScreen = {
  scores: Record<string, number>
  criteria: { id: string; label: string; scores: Record<string, number> }[]
  /** Why JEV could not score an option, by key: kept only under decision rules. */
  unscoredReasons?: Record<string, string>
}

/** The screen's scores, or why JEV could not give them. */
export function readFindScreen(outcome: GraphOutcome): FindScreen | { error: string } {
  const value =
    'value' in outcome
      ? (outcome.value as Partial<FindScreen> & { error?: unknown; markdown?: unknown })
      : undefined
  if (!value || typeof value.error === 'string' || !value.scores || !value.criteria) {
    return { error: typeof value?.error === 'string' ? value.error : 'JEV could not screen them' }
  }
  const reasons = value.unscoredReasons
  return {
    scores: value.scores,
    criteria: value.criteria,
    ...(reasons && typeof reasons === 'object' ? { unscoredReasons: reasons } : {})
  }
}

/** Highest score first; equal scores keep the pool's order. Find and Decide rank alike. */
export function findBestFirst<T>(
  options: readonly T[],
  pool: readonly T[],
  score: (option: T) => number
): T[] {
  return [...options].sort(
    (left, right) => score(right) - score(left) || pool.indexOf(left) - pool.indexOf(right)
  )
}

/**
 * Every option best first: the winner, the other finalists by their place in the final, the rest
 * by JEV's score, then the ones JEV could not score in pool order. The first `keep` are kept.
 */
export function findRows(input: {
  pool: readonly FindOption[]
  screen?: FindScreen
  finalists: readonly FindOption[]
  /** The final's places by option key, for finalists the judges placed. */
  places: ReadonlyMap<string, number>
  winner: FindOption
  keep: number
  /** The person's check on each complete version, by option key. */
  checks?: ReadonlyMap<string, GraphCheckResult>
  /** find-screen@2: the options JEV could not score, with the reason. */
  notScored?: WorkflowFindTrail['notScored']
}): WorkflowFindRow[] {
  const { pool, screen, places, winner } = input
  const score = (option: FindOption) => screen?.scores[option.key]
  const byScore = (left: FindOption, right: FindOption) =>
    (score(right) ?? -1) - (score(left) ?? -1) || pool.indexOf(left) - pool.indexOf(right)
  const place = (option: FindOption) => places.get(option.key) ?? Number.MAX_SAFE_INTEGER
  const finalists = new Set(input.finalists.map((option) => option.key))
  const rest = pool.filter((option) => !finalists.has(option.key))
  const order = [
    winner,
    ...input.finalists
      .filter((option) => option.key !== winner.key)
      .toSorted((left, right) => place(left) - place(right) || byScore(left, right)),
    ...rest.filter((option) => score(option) !== undefined).toSorted(byScore),
    ...rest.filter((option) => score(option) === undefined)
  ]
  const criteria = screen?.criteria ?? []
  return order.map((option, index) => {
    const overall = score(option)
    const finalPlace = places.get(option.key)
    const notScored = input.notScored?.find((entry) => entry.key === option.key)?.reason
    return {
      key: option.key,
      title: option.title,
      detail: option.detail,
      ...(option.url ? { url: option.url } : {}),
      // The same judge-safe text every judge path and every continuation reads, regardless of
      // the run's admitted rules: this is view/continuation data, never fed back into a live
      // call, so it is never gated by findRules (only the historical screening/final JEV/model
      // prompt inputs are — see findOptionText).
      judgeText: findJudgeText(option),
      by: option.by,
      ...(overall !== undefined ? { score: overall } : {}),
      scores: criteria.map((criterion) => criterion.scores[option.key] ?? null),
      ...(finalPlace !== undefined ? { finalPlace } : {}),
      ...(finalists.has(option.key) ? { finalist: true as const } : {}),
      ...(index < input.keep ? { kept: true as const } : {}),
      ...(option.facts ? { facts: option.facts } : {}),
      ...(input.checks?.has(option.key) ? { check: rowCheck(input.checks.get(option.key)!) } : {}),
      ...(notScored ? { notScored } : {})
    }
  })
}
