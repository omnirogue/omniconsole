import { workflowFindScreeningText } from '../../../../shared/workflow-find-trail'
import type {
  WorkflowFindPick,
  WorkflowFindRow,
  WorkflowFindTrail
} from '../../../../shared/workflow-find-trail'
import { parseReviewStepInstructions } from '../../../../shared/review-rubrics'
import { findJudgeStep, findOptionsStep } from '../../../../shared/workflow-graph-find'
import { graphPlural, type GraphRunOutcome } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { findNotScoredGap } from './graph-find-unscored'

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text

/** A kept option as the report lists it; the results files keep its full text. */
const shown = (row: WorkflowFindRow) => ({
  ...row,
  title: clip(row.title, 300),
  detail: clip(row.detail, 600)
})

const score = (pick: Pick<WorkflowFindPick, 'score'> & Pick<WorkflowFindRow, 'notScored'>) =>
  pick.score !== undefined
    ? ` (${pick.score.toFixed(1)} of 4)`
    : pick.notScored
      ? ' (not scored by JEV)'
      : ''

function list(
  picks: readonly (Omit<WorkflowFindPick, 'key'> & Pick<WorkflowFindRow, 'notScored'>)[],
  withDetail: boolean
): string {
  return picks
    .map(
      (pick, index) =>
        `${index + 1}. **${pick.title}**${score(pick)}${withDetail && pick.detail ? ` — ${pick.detail}` : ''} · ${pick.by}`
    )
    .join('\n')
}

function decided(trail: WorkflowFindTrail): string {
  const by = trail.decidedBy ?? []
  if (by.includes('check')) {
    return 'your check decided'
  }
  if (by.includes('screen')) {
    return 'no judge could vote in the final, so the highest JEV score stands'
  }
  if (by.includes('models') && !by.includes('jev')) {
    return trail.jevUnsure
      ? 'JEV was unsure, so the model judges decided'
      : 'decided by the model judges'
  }
  return by.includes('models') ? 'decided by JEV and the model judges' : 'decided by JEV'
}

function report(scope: GraphScope, trail: WorkflowFindTrail): string {
  const winner = trail.winner!
  const judge = findJudgeStep(scope.config.spec)!
  const names = [
    ...new Set(
      (scope.config.agentSeats[findOptionsStep(scope.config.spec)!.id] ?? []).map(scope.nameOf)
    )
  ]
  const finalists = trail.overall.length
  const kept = (trail.rows ?? []).filter((row) => row.kept).map(shown)
  const rubricName = parseReviewStepInstructions(judge.instruction).shared?.name
  const versions = trail.source === 'versions'
  const how = [
    ...workflowFindScreeningText(trail),
    trail.source === 'list'
      ? `You gave ${graphPlural(trail.pool, 'option')}${
          trail.importReceipt
            ? ` (read ${trail.importReceipt.read}, imported ${trail.importReceipt.imported}, ` +
              `${graphPlural(trail.importReceipt.skipped.length, 'row')} skipped, ` +
              `${graphPlural(trail.importReceipt.merged, 'duplicate')} merged).`
            : trail.importMerged !== undefined
              ? ` (${graphPlural(trail.importMerged, 'duplicate')} merged in by title, detail and link).`
              : '.'
        }`
      : versions
        ? `${graphPlural(trail.pool, 'complete version')} came from ${names.join(', ')}, each from its own angle.`
        : `${graphPlural(trail.pool, 'option')} came up from ${names.join(', ')}, duplicates merged.`,
    trail.check
      ? `Every version ran your check (\`${trail.check.command}\`): ${trail.check.passed} of ${trail.check.checked} passed. Passing, then a higher score, outranks every judge.`
      : '',
    trail.facts?.fetched
      ? `GitHub's facts (stars, forks, last push, license…) were fetched for ${trail.facts.fetched} of ${graphPlural(trail.facts.repos, 'repository', 'repositories')}, and the judges read them.`
      : '',
    trail.scored !== undefined
      ? `JEV scored ${trail.scored} of them against ${rubricName ? `the ${rubricName} rubric` : judge.instruction.trim() ? 'what good means' : 'the general rubric'}${trail.unscored ? `; it could not score ${trail.unscored}` : ''}.`
      : '',
    finalists > 1
      ? `The top ${finalists} met head to head: ${decided(trail)}.`
      : trail.decidedBy?.includes('check')
        ? 'Your check left one version on top, so no judge was needed.'
        : `Only one ${versions ? 'version' : 'option'} reached the final.`,
    kept.length > finalists && finalists > 1 && !trail.decidedBy?.includes('screen')
      ? `Places 1 to ${finalists} come from the final; the rest are in JEV's score order.`
      : ''
  ].filter(Boolean)
  const byline = `_${winner.score !== undefined ? `JEV score ${winner.score.toFixed(1)} of 4 · ` : ''}from ${winner.by}_`
  return [
    // A version is the deliverable itself, so it is shown whole; the list names the others.
    ...(versions
      ? [`## Best version: ${winner.title}`, `${trail.rows![0]!.detail}\n\n${byline}`]
      : [`## Best option: ${winner.title}`, [winner.detail, byline].filter(Boolean).join('\n\n')]),
    `## Top ${kept.length}`,
    list(kept, !versions),
    ...trail.byCriterion.flatMap((entry) => [
      `## Top ${entry.picks.length} for "${entry.criterion}"`,
      list(entry.picks, false)
    ]),
    '## How this was found',
    how.map((line) => `- ${line}`).join('\n')
  ].join('\n\n')
}

/**
 * How a Find the best run ends: the report when the final named a best option, else the reason.
 * Options JEV could not score, and a final no judge could vote in, are named as gaps.
 */
export function graphFindOutcome(scope: GraphScope): GraphRunOutcome {
  const trail = scope.find!
  const gaps: string[] = []
  for (const run of scope.runs[findOptionsStep(scope.config.spec)!.id] ?? []) {
    if (run.state === 'gaps' && run.reason) {
      gaps.push(`Options: ${run.reason}`)
    }
  }
  if (trail.harvest?.error) {
    gaps.push(
      `The GitHub search for "${trail.harvest.query}" found nothing (${trail.harvest.error}); only the other options were judged.`
    )
  }
  if (trail.harvest?.dropped) {
    gaps.push(
      `GitHub returned ${graphPlural(trail.harvest.dropped, 'result')} without a usable owner/name; ${trail.harvest.dropped === 1 ? 'it was' : 'they were'} left out.`
    )
  }
  if (trail.facts?.error) {
    gaps.push(
      `GitHub facts were not fetched (${trail.facts.error}); the repositories were judged on their text alone.`
    )
  } else if (trail.facts?.failed.length) {
    const named = trail.facts.failed.slice(0, 5).join(', ')
    const more = trail.facts.failed.length > 5 ? ` and ${trail.facts.failed.length - 5} more` : ''
    gaps.push(
      `GitHub facts could not be fetched for ${graphPlural(trail.facts.failed.length, 'repository', 'repositories')}: ${named}${more}.`
    )
  }
  if (trail.check && !trail.check.passed) {
    gaps.push('No version passed your check.')
  }
  if (trail.check?.unavailable) {
    gaps.push(
      `Your check could not run on ${graphPlural(trail.check.unavailable, 'version')}; ${trail.check.unavailable === 1 ? 'it counts' : 'they count'} as failing.`
    )
  }
  if (trail.notScored) {
    gaps.push(findNotScoredGap(trail.notScored))
  } else if (trail.unscored) {
    gaps.push(
      `JEV could not score ${graphPlural(trail.unscored, 'option')}; ${trail.unscored === 1 ? 'it was' : 'they were'} left out.`
    )
  }
  if (trail.decidedBy?.includes('screen') && trail.overall.length > 1) {
    gaps.push('No judge could vote in the final, so the highest JEV score stands.')
  }
  if (trail.stage !== 'done' || !trail.winner) {
    return { state: 'failed', error: trail.reason ?? 'Find the best did not finish.', gaps }
  }
  const judge = findJudgeStep(scope.config.spec)!
  return { state: 'completed', gaps, final: { stepId: judge.id, markdown: report(scope, trail) } }
}
