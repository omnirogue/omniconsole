import { isIndependentLineage, type ModelLineage } from '../../../../shared/model-lineage'
import type { WorkflowExplore } from '../../../../shared/workflow-graph'
import type { WorkflowImprovePrediction } from '../../../../shared/workflow-improve-trail'
import type {
  GraphCandidate,
  GraphCheckResult,
  GraphImproveRole,
  GraphImproveRound,
  GraphNamedText,
  GraphStepRun
} from './graph-plan-types'

/** A version of the work: who made it, in which round, in which role, and what its check found. */
export type ImproveVersion = {
  text: GraphNamedText
  round: number
  role: GraphImproveRole | 'best'
  check?: GraphCheckResult
  /** Several versions to build on: the one this version built on, for the trail. */
  parent?: { round: number; name: string }
  /** Predictions on: whether what the version predicted about its test held. */
  prediction?: WorkflowImprovePrediction
  /** Rules 3, a change to the code: its change, diff noise aside (normalizedPatchKey). */
  patchKey?: string
  /** Rules 3: the earlier version with the same change, whose check result it reused. */
  duplicateOf?: { round: number; name: string }
}

/**
 * Which improvers explore: none when exploring is low, half when it is high, otherwise one of
 * three or more. The rest build on the best version (or, in round one, make first versions).
 */
export function graphImproveRoles(
  count: number,
  mode: GraphImproveRound['mode'],
  explore: WorkflowExplore
): GraphImproveRole[] {
  if (mode === 'divergent') {
    return Array.from({ length: count }, () => 'divergent')
  }
  const explorers =
    explore === 'low' ? 0 : explore === 'high' ? Math.floor(count / 2) : count >= 3 ? 1 : 0
  return Array.from({ length: count }, (_, index) =>
    index >= count - explorers ? 'explore' : mode === 'first' ? 'first' : 'improve'
  )
}

/** The incumbent sits at a different place each round, so no position favours it for long. */
export function arrangeImproveLineup(
  best: ImproveVersion | undefined,
  challengers: ImproveVersion[],
  round: number
): ImproveVersion[] {
  if (!best) {
    return challengers
  }
  const at = round % (challengers.length + 1)
  return [...challengers.slice(0, at), best, ...challengers.slice(at)]
}

/**
 * Whether a challenger's lead over the incumbent rests on more than its own family's taste: a
 * counted JEV ballot (no model family's) or a judge of another known family ranked it above. A
 * challenger of unknown family cannot be shown to share one, so it is never held back for it.
 */
function crossFamilyLead(
  run: GraphStepRun,
  winner: GraphCandidate,
  incumbent: GraphCandidate,
  lineageOf: (seatId: string) => ModelLineage
): boolean {
  const family = lineageOf(winner.seatId)
  const above = (ranking: readonly string[] | undefined) => {
    const at = ranking?.indexOf(winner.label) ?? -1
    const below = ranking?.indexOf(incumbent.label) ?? -1
    return at !== -1 && (below === -1 || at < below)
  }
  const modelVoted = run.calls.some((view) => !view.jev && view.ranking)
  // An unsure JEV the model judges stood in for was not counted (graph-step-derive.ts).
  const jevCounted = !run.jevUnsure || !!run.jevCounted || !modelVoted
  return run.calls.some((view) =>
    view.jev
      ? jevCounted && above(view.ranking)
      : above(view.ranking) &&
        (family === 'unknown'
          ? lineageOf(view.seatId) !== 'unknown'
          : isIndependentLineage(lineageOf(view.seatId), family))
  )
}

/**
 * Who holds the round. Ties go to the incumbent, and so does any doubt: no counted vote, an
 * incumbent the judges could not rank, or an unsure JEV that no model judge could settle. With
 * `lineageOf` (rules 3), so does a lead only the challenger's own model family gave it.
 */
export function decideImproveRound(
  lineup: ImproveVersion[],
  candidates: GraphCandidate[],
  run: GraphStepRun,
  best: ImproveVersion | undefined,
  lineageOf?: (seatId: string) => ModelLineage
): { index: number; unjudged?: true; reason?: string } {
  // The incumbent is the very version carried in, found by identity, never by a marker.
  const incumbent = best ? lineup.indexOf(best) : -1
  const counted = (run.standings ?? []).filter((row) => row.votes > 0)
  const keep = (reason: string) =>
    incumbent >= 0 ? { index: incumbent, unjudged: true as const, reason } : { index: 0, reason }
  if (run.state === 'failed' || run.state === 'not-run' || !counted.length) {
    const why = `No judge vote counted${run.reason ? ` (${run.reason})` : ''}`
    // Round one has no best version yet: the first version is taken, and that is said.
    return keep(
      incumbent >= 0
        ? `${why}, so the best version so far stays.`
        : `${why}, so the first version that came back was taken unjudged.`
    )
  }
  const first = Math.min(...counted.map((row) => row.place))
  const top = counted
    .filter((row) => row.place === first)
    .map((row) => candidates.findIndex((candidate) => candidate.label === row.label))
  const modelVoted = run.calls.some((view) => !view.jev && view.ranking)
  if (incumbent < 0) {
    if (run.jevUnsure && !modelVoted) {
      // An unsure lean still beats chance (JEV Lab: 73% agreement with Opus inside the band).
      return {
        index: top[0],
        unjudged: true,
        reason:
          "JEV was not sure and no model judge could settle it, so JEV's closer pick was taken unjudged."
      }
    }
    return { index: top[0] }
  }
  if (top.includes(incumbent)) {
    return { index: incumbent }
  }
  if (run.jevUnsure && !modelVoted) {
    return keep('JEV was not sure and no model judge could settle it, so the best version stays.')
  }
  if (!counted.some((row) => row.label === candidates[incumbent].label)) {
    return keep('The judges could not rank the best version so far, so it stays.')
  }
  if (lineageOf && !crossFamilyLead(run, candidates[top[0]], candidates[incumbent], lineageOf)) {
    return keep(
      "Only judges from the challenger's own model family preferred it, so the best version stays."
    )
  }
  return { index: top[0] }
}

/** The strongest losing version that took a different line: explorers develop it next. */
export function nextImproveAlternative(
  lineup: ImproveVersion[],
  candidates: GraphCandidate[],
  run: GraphStepRun,
  winner: number
): ImproveVersion | undefined {
  const ranked = (run.standings ?? []).filter((row) => row.votes > 0)
  for (const row of ranked) {
    const index = candidates.findIndex((candidate) => candidate.label === row.label)
    const version = lineup[index]
    if (index !== winner && version && version.role !== 'best' && version.role !== 'improve') {
      return version
    }
  }
  return undefined
}
