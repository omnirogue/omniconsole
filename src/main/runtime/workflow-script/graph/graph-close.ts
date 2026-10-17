import { WORKFLOW_CLOSE_GAP } from '../../../../shared/workflow-graph'
import type { GraphScope } from './graph-scope'

/**
 * Why a crux is not needed: the ranking's top two are clearly apart, or it placed fewer than two.
 * A ranking with an unsettled rubric line is never called clear: the crux runs.
 */
export function graphNotClose(scope: GraphScope, rankId: string): string | undefined {
  const output = scope.outputOf(rankId)
  if (output.status !== 'ok') {
    return `Not run: ${scope.title(rankId)} did not finish, so whether the top two are close is unknown.`
  }
  const run = output.run
  if (run.criteria?.some((entry) => entry.unsettled)) {
    return undefined
  }
  const top = (run.standings ?? [])
    .filter((row) => row.votes > 0)
    .sort((left, right) => left.place - right.place || left.label.localeCompare(right.label))
  const name = (label: string) =>
    run.candidates?.find((entry) => entry.label === label)?.name ?? label
  if (top.length < 2) {
    return `Not needed: ${scope.title(rankId)} placed fewer than two options.`
  }
  const gap = top[1]!.averageRank - top[0]!.averageRank
  return gap > WORKFLOW_CLOSE_GAP
    ? `Not needed: ${name(top[0]!.label)} led ${name(top[1]!.label)} clearly (by ${gap.toFixed(2)} places).`
    : undefined
}
