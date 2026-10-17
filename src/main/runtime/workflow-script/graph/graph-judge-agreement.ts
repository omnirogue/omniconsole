import { graphStandings } from './graph-parse'
import type { GraphCandidate, GraphStepRun } from './graph-plan-types'

/**
 * How far JEV and the model judges agreed on one round: whether they put the same answer first,
 * and the share of answer pairs every model ballot ordered the way JEV did. Undefined unless both
 * gave a ballot.
 */
export function graphJudgeAgreement(
  run: GraphStepRun,
  candidates: readonly GraphCandidate[]
): { topSame: boolean; pairs: number } | undefined {
  const jev = run.calls.find((view) => view.jev && view.ranking)?.ranking
  const models = run.calls
    .filter((view) => !view.jev && view.ranking)
    .map((view) => ({ seatId: view.seatId, ranking: view.ranking! }))
  if (!jev || !models.length) {
    return undefined
  }
  const modelTop = graphStandings(candidates, models).find(
    (standing) => standing.votes > 0 && standing.place === 1
  )?.label
  let same = 0
  let total = 0
  for (const ballot of models) {
    for (let first = 0; first < jev.length; first++) {
      for (let second = first + 1; second < jev.length; second++) {
        const a = ballot.ranking.indexOf(jev[first]!)
        const b = ballot.ranking.indexOf(jev[second]!)
        if (a !== -1 && b !== -1) {
          total++
          same += a < b ? 1 : 0
        }
      }
    }
  }
  return { topSame: modelTop === jev[0], pairs: total ? Math.round((same / total) * 100) / 100 : 0 }
}
