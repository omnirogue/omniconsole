import { formatGraphItem, graphSeverityRank } from './graph-items'
import type { GraphRunOutcome } from './graph-plan-types'
import type { GraphScope } from './graph-scope'

/** A report from the actual items and verdicts, without another model call. */
export function graphQuickDiscoverOutcome(scope: GraphScope, gaps: string[]): GraphRunOutcome {
  const found = scope.outputs.get('find')
  if (found?.status !== 'ok') {
    return { state: 'failed', error: 'Quick Discover reader failed.', gaps }
  }
  const reviews = scope.config.spec.steps.filter((step) => step.kind === 'review')
  const targets = new Map(
    reviews.flatMap((step) =>
      (scope.runs[step.id] ?? []).flatMap((run) =>
        (run.targets ?? []).map((target) => [target.item.key, target] as const)
      )
    )
  )
  const items = [...(found.run.items ?? [])].sort(
    (a, b) => graphSeverityRank(a.severity) - graphSeverityRank(b.severity)
  )
  const actionable = items.filter((item) => targets.get(item.key)?.tally !== 'refuted')
  const ranking = actionable.map((item, index) => ({
    key: item.key,
    rank: index + 1,
    why: '',
    next: ''
  }))
  const markdown = [
    '# Quick Discover',
    reviews.length
      ? 'One reader covered the scope; findings carry the independent Verify verdict when available.'
      : 'Single pass: every finding is unverified.',
    ...(items.length
      ? items.map(
          (item) =>
            `## ${item.title} — ${targets.get(item.key)?.tally ?? 'unverified (single pass)'}\n\n${formatGraphItem(item)}`
        )
      : ['No findings reported.'])
  ].join('\n\n')
  for (const step of reviews) {
    const output = scope.outputs.get(step.id)
    if (output?.status === 'failed' || output?.status === 'not-run') {
      gaps.push(`Verify: ${output.reason}`)
    }
  }
  return {
    state: 'completed',
    gaps,
    final: { stepId: reviews.at(-1)?.id ?? 'find', markdown, ranking }
  }
}
