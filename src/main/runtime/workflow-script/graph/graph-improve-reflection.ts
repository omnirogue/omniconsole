import { JEV_SCORE_LEVELS } from '../../../structured-decisions/jev-rank-rubric'
import { graphPredictionKept } from './graph-check-prediction'
import {
  GRAPH_PATCH_NO_DIFF,
  GRAPH_PATCH_REFUSED,
  GRAPH_PATCH_UNAPPLIED
} from './graph-check-patch'
import type { ImproveVersion } from './graph-improve-decide'
import type { GraphJevJudgment } from './graph-jev'
import type { GraphCheckResult, GraphImproveRound, GraphStepRun } from './graph-plan-types'
import type { GraphScope } from './graph-scope'

/** A JEV rubric criterion and the best version's score on it, 0–4. */
export type GraphImproveCriterion = { label: string; score: number }

/** Why a version was not kept. */
export type GraphImproveRejectReason =
  | 'prediction_missed'
  | 'check_failed'
  | 'repeated_change'
  | 'identical_to_best'
  | 'score_below_best'
  | 'lost_to_baseline'
  | 'lost_to_best'
  | 'lost_to_round_winner'

/**
 * What a version's check found, by kind: read from the app's own wording and counts, never from
 * the command's output, which can quote any data the test touched.
 */
export type GraphImproveCheckFinding =
  | 'no_diff'
  | 'patch_refused'
  | 'patch_apply_failed'
  | 'early_exit_flagged'
  | 'check_unavailable'
  | 'cases_failed'
  | 'check_command_failed'

/** A version that was not kept: what it tried and why it lost, in codes and counts only. */
export type GraphImproveRejected = {
  name: string
  round: number
  summary: string
  reason: GraphImproveRejectReason
  check?: GraphImproveCheckFinding
  cases?: { passed: number; total: number; unavailable: number }
  /** Calls the change adds that end the process early, by name. */
  exits?: string[]
  /** Its SCORE and the best version's, when the lower one is why it lost. */
  score?: { own: number; best: number }
  /** The version the judges preferred to it. */
  preferred?: { name: string; round: number }
  /** The earlier version whose change it repeated. */
  repeats?: { name: string; round: number }
}

/** Improve rules 3: what improvers fix first, and what they must not try again. */
export type GraphImproveReflection = {
  /** The best version's weakest JEV rubric criteria, lowest first. */
  weakest?: GraphImproveCriterion[]
  /** Newest first, at most MAX_REJECTED. */
  rejected: GraphImproveRejected[]
}

const MAX_REJECTED = 5
const MAX_WEAKEST = 2
const SUMMARY_CHARS = 160

/**
 * The best version's weakest criteria by JEV's rubric scores in this round's ballot. None when
 * JEV compared head to head (no per-criterion scores), or gave no ballot.
 */
export function graphImproveWeakest(
  scope: GraphScope,
  run: GraphStepRun,
  label: string
): GraphImproveCriterion[] {
  const view = run.calls.find((entry) => entry.jev && entry.status === 'done')
  const outcome = view ? scope.outcomes.get(view.id) : undefined
  const value =
    outcome && 'value' in outcome ? (outcome.value as { judgment?: GraphJevJudgment } | null) : null
  const top = JEV_SCORE_LEVELS.length - 1
  return (value?.judgment?.criteria ?? [])
    .flatMap((criterion) => {
      const score = criterion.scores?.[label]
      return typeof score === 'number' && score < top ? [{ label: criterion.label, score }] : []
    })
    .sort((left, right) => left.score - right.score)
    .slice(0, MAX_WEAKEST)
}

/** What a check found when it did not simply pass; undefined for a clean pass or no check. */
function graphImproveCheckFinding(
  check: GraphCheckResult | undefined
): GraphImproveCheckFinding | undefined {
  if (!check) {
    return undefined
  }
  if (check.unavailable) {
    return 'check_unavailable'
  }
  if (check.exits?.length) {
    return 'early_exit_flagged'
  }
  if (check.passed) {
    return undefined
  }
  if (check.detail.startsWith(GRAPH_PATCH_NO_DIFF)) {
    return 'no_diff'
  }
  if (check.detail.startsWith(GRAPH_PATCH_REFUSED)) {
    return 'patch_refused'
  }
  if (check.detail.startsWith(GRAPH_PATCH_UNAPPLIED)) {
    return 'patch_apply_failed'
  }
  return check.cases && check.cases.passed < check.cases.total
    ? 'cases_failed'
    : 'check_command_failed'
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** One line: the files a diff changes and its first added lines, else the first line of text. */
function summaryOf(markdown: string): string {
  const lines = markdown.split('\n').map((line) => line.trimEnd())
  const files = [...new Set(lines.flatMap((line) => /^\+\+\+ b\/(.+)$/.exec(line)?.[1] ?? []))]
  const added = lines
    .filter((line) => /^\+(?!\+\+)/.test(line))
    .map((line) => line.slice(1).trim())
    .filter(Boolean)
  const text = files.length
    ? `${files.join(', ')}: ${added.slice(0, 2).join(' / ')}`
    : (lines.map((line) => line.replace(/^[\s#>*`-]+/, '').trim()).find(Boolean) ?? '')
  return clip(text.replace(/\s+/g, ' ').trim(), SUMMARY_CHARS)
}

/** Why a version was not kept; undefined when nothing judged it (nothing to learn from). */
function rejectedEntry(
  version: ImproveVersion,
  result: GraphImproveRound['result'],
  before: ImproveVersion | undefined,
  after: ImproveVersion | undefined
): GraphImproveRejected | undefined {
  const check = version.check
  const found = graphImproveCheckFinding(check)
  const entry = (
    reason: GraphImproveRejectReason,
    extra: Partial<GraphImproveRejected> = {}
  ): GraphImproveRejected => ({
    name: version.text.name,
    round: version.round,
    summary: summaryOf(version.text.markdown),
    reason,
    ...(found ? { check: found } : {}),
    ...(check?.cases
      ? {
          cases: {
            passed: check.cases.passed,
            total: check.cases.total,
            unavailable: check.cases.unavailable
          }
        }
      : {}),
    ...(check?.exits?.length ? { exits: [...check.exits] } : {}),
    ...(version.duplicateOf ? { repeats: { ...version.duplicateOf } } : {}),
    ...extra
  })
  if (version.prediction && !graphPredictionKept(version.prediction)) {
    return entry('prediction_missed')
  }
  if (check && !check.passed && !check.unavailable) {
    return entry('check_failed')
  }
  if (version.duplicateOf) {
    return entry('repeated_change')
  }
  if (after && version.text.markdown.trim() === after.text.markdown.trim()) {
    return entry('identical_to_best')
  }
  const bestScore = after?.check?.score
  if (check?.score !== undefined && bestScore !== undefined && check.score < bestScore) {
    return entry('score_below_best', { score: { own: check.score, best: bestScore } })
  }
  if (result !== 'kept' && result !== 'new-best' && result !== 'first') {
    return undefined
  }
  const reason =
    after?.round === 0
      ? 'lost_to_baseline'
      : after && after.text.callId === before?.text.callId
        ? 'lost_to_best'
        : 'lost_to_round_winner'
  return entry(reason, after ? { preferred: { name: after.text.name, round: after.round } } : {})
}

/**
 * What the next round's improvers are told: this round's versions that were not kept, ahead of
 * the earlier ones, and the best version's weakest criteria. A best version no judge scored this
 * round keeps the weakest criteria it was last scored on.
 */
export function nextImproveReflection(input: {
  previous: GraphImproveReflection | undefined
  challengers: readonly ImproveVersion[]
  result: GraphImproveRound['result']
  before: ImproveVersion | undefined
  after: ImproveVersion | undefined
  weakest: GraphImproveCriterion[] | undefined
}): GraphImproveReflection | undefined {
  const { previous, before, after } = input
  const rejected = input.challengers.flatMap((version): GraphImproveRejected[] => {
    if (version.text.callId === after?.text.callId) {
      return []
    }
    const entry = rejectedEntry(version, input.result, before, after)
    return entry ? [entry] : []
  })
  const sameBest = !!after && after.text.callId === before?.text.callId
  const weakest = input.weakest?.length ? input.weakest : sameBest ? previous?.weakest : undefined
  const list = [...rejected, ...(previous?.rejected ?? [])].slice(0, MAX_REJECTED)
  return list.length || weakest?.length
    ? { ...(weakest?.length ? { weakest } : {}), rejected: list }
    : undefined
}
