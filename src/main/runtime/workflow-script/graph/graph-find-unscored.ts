import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import { WORKFLOW_MAX_RANK_CANDIDATES } from '../../../../shared/workflow-graph'
import type { FindOption } from './graph-find-pool'
import type { FindScreen } from './graph-find-rows'
import { graphPlural } from './graph-plan-types'

type NotScored = NonNullable<WorkflowFindTrail['notScored']>

/**
 * find-screen@2: an option JEV could not score is never read as low. It joins the final unscored
 * while the final holds fewer than a Rank step can judge, and every one is named with the reason.
 */
export function keepUnscored(
  pool: readonly FindOption[],
  finalists: FindOption[],
  screen: FindScreen,
  trail: WorkflowFindTrail
): FindOption[] {
  const unscored = pool.filter((option) => screen.scores[option.key] === undefined)
  if (!unscored.length) {
    return finalists
  }
  const room = Math.max(0, WORKFLOW_MAX_RANK_CANDIDATES - finalists.length)
  trail.notScored = unscored.map((option, index) => ({
    key: option.key,
    title: option.title.slice(0, 300),
    reason: screen.unscoredReasons?.[option.key] ?? 'JEV gave no score',
    ...(index < room ? { finalist: true as const } : {})
  }))
  return [...finalists, ...unscored.slice(0, room)]
}

const named = (entries: NotScored) =>
  entries.map((entry) => `${entry.title} (${entry.reason})`).join('; ')

/** What a find-screen@2 run reports as a gap: which options went unscored, why, and where. */
export function findNotScoredGap(notScored: NotScored): string {
  const joined = notScored.filter((entry) => entry.finalist).length
  const left = notScored.filter((entry) => !entry.finalist)
  const them = (count: number) => (count === 1 ? 'it' : 'them')
  return [
    `JEV could not score ${graphPlural(notScored.length, 'option')}, so none was read as low: ${named(notScored)}.`,
    ...(joined
      ? [
          `${joined === notScored.length ? (joined === 1 ? 'It' : 'They') : joined} went to the final unscored, so only the final's judges placed ${them(joined)}.`
        ]
      : []),
    ...(left.length
      ? [
          `The final had no room for ${graphPlural(left.length, 'more option')}, so no judge compared ${them(left.length)}: ${left.map((entry) => entry.title).join('; ')}.`
        ]
      : [])
  ].join(' ')
}
