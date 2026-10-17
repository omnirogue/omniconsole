import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { councilMarkdown } from '../presets/council-ranking'
import type { GraphOutcome } from './graph-plan-types'
import { sameGraphClaim, type GraphItem } from './graph-items'
import { parseGraphVerdict, type GraphVerdict } from './graph-parse'

/** A grouped claim has a verdict only when every report was judged separately and agrees. */
export function graphMergedVerdict(item: GraphItem, markdown: string): GraphVerdict | null {
  if (!item.alsoReported?.some((report) => !sameGraphClaim(item, report))) {
    return parseGraphVerdict(markdown) ?? null
  }
  const reports = [item, ...item.alsoReported]
  const verdicts = reports.map((_, index) => {
    const match = new RegExp(`^REPORT ${index + 1}: (PASS|FAIL|UNSURE)\\s*$`, 'im').exec(markdown)
    return match?.[1]?.toLowerCase()
  })
  return verdicts.every((vote) => vote === 'pass')
    ? 'pass'
    : verdicts.every((vote) => vote === 'fail')
      ? 'fail'
      : 'unsure'
}

/** Whether an item's first review sends it on to the other reviewers (graphEscalations). */
export function graphWantsEscalation(
  step: WorkflowStep,
  item: GraphItem,
  first: GraphOutcome,
  independent: boolean,
  legacy = false
): boolean {
  const text = 'value' in first ? councilMarkdown(first.value) : undefined
  // Promised another family but none could be found: a pass from the finder's own is not enough.
  const alone = !!step.escalate?.crossFamily && !independent
  return (
    item.severity === 'critical' ||
    !text ||
    (legacy ? parseGraphVerdict(text) : graphMergedVerdict(item, text)) !== 'pass' ||
    alone
  )
}
