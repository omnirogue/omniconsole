import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { formatGraphItem, graphSeverityRank } from './graph-items'
import type { GraphRunOutcome } from './graph-plan-types'
import { graphJevVerdictNote } from './graph-report-evidence'
import type { GraphScope } from './graph-scope'

/** A settled Verify survives a missing Report without another model call. */
export function graphDiscoverReportFallback(
  scope: GraphScope,
  final: WorkflowStep | undefined,
  reason: string,
  gaps: string[]
): GraphRunOutcome | undefined {
  if (
    scope.config.spec.template !== 'discover' ||
    final?.id !== 'report' ||
    final.kind !== 'synthesize'
  ) {
    return undefined
  }
  const verify = scope.outputs.get('verify')
  if (!verify || !('run' in verify) || !verify.run?.targets) {
    return undefined
  }
  const targets = [...verify.run.targets].sort(
    (a, b) =>
      (b.item.impact?.score ?? 0) - (a.item.impact?.score ?? 0) ||
      graphSeverityRank(a.item.severity) - graphSeverityRank(b.item.severity) ||
      a.item.key.localeCompare(b.item.key)
  )
  const gap = `Report failed: ${reason} A deterministic report preserves the settled Verify results, ordered by impact, then severity.`
  return {
    state: 'completed',
    gaps: [...gaps, gap],
    final: {
      stepId: final.id,
      markdown: [
        '# Discover report',
        gap,
        ...targets.map(
          (target, index) =>
            `## ${index + 1}. ${target.item.title} (${target.tally})\n\n${formatGraphItem(target.item)}${graphJevVerdictNote(target)}`
        ),
        ...(targets.length ? [] : ['Verify settled with no findings.'])
      ].join('\n\n'),
      ranking: targets.map((target, index) => ({
        key: target.item.key,
        rank: index + 1,
        why: target.item.impact?.why ?? `Reported severity: ${target.item.severity}.`,
        next: 'Review the finding and its evidence before acting.'
      }))
    }
  }
}
