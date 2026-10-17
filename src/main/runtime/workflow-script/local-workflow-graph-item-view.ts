import type { LocalWorkflowGraphItem } from '../../../shared/local-workflow-view'
import type { GraphItem } from './graph/graph-items'

/** An item as the run view shows it. */
export function graphItemView(item: GraphItem): LocalWorkflowGraphItem {
  return {
    key: item.key,
    title: item.title,
    detail: item.detail,
    location: item.location,
    severity: item.severity,
    repeats: item.repeats,
    round: item.round,
    sourceCallId: item.sourceCallId,
    ...(item.alsoFrom?.length ? { alsoFrom: item.alsoFrom } : {}),
    ...(item.alsoMerged?.length ? { alsoMerged: item.alsoMerged } : {}),
    ...(item.alsoReported?.length ? { alsoReported: item.alsoReported } : {}),
    ...(item.reportedSeverity ? { reportedSeverity: item.reportedSeverity } : {}),
    ...(item.jev ? { jev: { score: item.jev.score } } : {}),
    ...(item.impact ? { impact: { score: item.impact.score, why: item.impact.why } } : {}),
    ...(item.evidence
      ? {
          evidence: {
            status: item.evidence.status,
            ...(item.evidence.line !== undefined ? { line: item.evidence.line } : {}),
            ...(item.evidence.preVerify
              ? {
                  preVerify: {
                    flags: item.evidence.preVerify.flags,
                    ...(item.evidence.preVerify.dropped
                      ? { dropped: item.evidence.preVerify.dropped }
                      : {})
                  }
                }
              : {})
          }
        }
      : {})
  }
}
