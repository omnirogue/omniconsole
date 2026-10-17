import type {
  LocalWorkflowGraphItem,
  LocalWorkflowVerifiedFinding
} from '../../../shared/local-workflow-graph-view'
import type { WorkflowSpec } from '../../../shared/workflow-graph'
import { graphConfirmedResult } from './graph/graph-input-section'
import type { GraphItem } from './graph/graph-items'
import type { GraphPlan, GraphTarget } from './graph/graph-plan-types'

/**
 * Every finding a review step has confirmed so far, for `omni workflow status`: a settled round's
 * confirmed targets, and a running round's items whose reviews are all in (graph-review-target.ts).
 * Planned from the durable call records on every read, so nothing else records it. Absent when no
 * step reviews items one by one.
 */
export function localWorkflowVerifiedFindings(
  spec: WorkflowSpec,
  plan: GraphPlan,
  settle: (target: GraphTarget) => GraphTarget,
  projectItem: (item: GraphItem) => LocalWorkflowGraphItem
): { verified?: LocalWorkflowVerifiedFinding[] } {
  const steps = spec.steps.filter((step) => step.kind === 'review' && step.forEach)
  if (!steps.length) {
    return {}
  }
  const found = new Map<string, LocalWorkflowVerifiedFinding>()
  for (const step of steps) {
    for (const run of plan.runs[step.id] ?? []) {
      for (const target of (run.targets ?? run.verifiedEarly ?? []).map(settle)) {
        if (!graphConfirmedResult(target) || found.has(target.item.key)) {
          continue
        }
        const { key, title, detail, location, severity } = projectItem(target.item)
        found.set(key, {
          key,
          title,
          detail,
          location,
          severity,
          stepId: step.id,
          round: run.round
        })
      }
    }
  }
  return { verified: [...found.values()] }
}
