import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { councilMarkdown } from '../presets/council-ranking'
import { graphFirstReview, graphReviewTally } from './graph-first-reviewer'
import type { GraphItem } from './graph-items'
import { graphMergedVerdict } from './graph-merged-verdict'
import type { GraphCallView, GraphStepRun } from './graph-plan-types'
import { graphUsesLegacyVerification, type GraphScope } from './graph-scope'
import { parseGraphVerdict } from './graph-parse'
import type { GraphTarget } from './graph-target'
import { graphWantsEscalation } from './graph-triage'

/** A reviewed item's votes and tally, from the answers of its settled review calls. */
export function graphReviewedTarget(
  scope: GraphScope,
  step: WorkflowStep,
  item: GraphItem,
  views: readonly GraphCallView[],
  valueOf: (callId: string) => unknown,
  capped = false
): GraphTarget {
  const texts = views.map((view) => councilMarkdown(valueOf(view.id)) ?? null)
  const votes = texts.map((text) =>
    text
      ? graphUsesLegacyVerification(scope)
        ? (parseGraphVerdict(text) ?? null)
        : graphMergedVerdict(item, text)
      : null
  )
  const voters = views.map((view) => view.agentIndex)
  return {
    item,
    votes,
    texts,
    ...(voters.some((agent, index) => agent !== index) ? { voters } : {}),
    ...graphReviewTally(
      scope,
      step,
      item,
      votes,
      voters,
      capped && !graphUsesLegacyVerification(scope)
    )
  }
}

/**
 * The reviews an item's verdict counts: all of them, except the first review a stand-in made
 * again (graphStandIns), which gave no answer.
 */
export function graphCountedViews(
  scope: GraphScope,
  step: WorkflowStep,
  item: GraphItem,
  views: readonly GraphCallView[],
  standIns: ReadonlyMap<string, number> | undefined
): readonly GraphCallView[] {
  if (!standIns?.has(item.key)) {
    return views
  }
  const replaced = graphFirstReview(scope, step, item).index
  return views.filter((view) => view.agentIndex !== replaced)
}

/**
 * While a review step still runs, the items it has already confirmed, so a run's status lists
 * each one as soon as its last review is in: all its calls settled and no further review can
 * follow. Live JEV verify only moves unverified items, so these stay confirmed; page-fed runs
 * wait for the step, as the page checks can still unsettle a pass.
 */
export function graphAttachVerifiedEarly(
  scope: GraphScope,
  step: WorkflowStep,
  run: GraphStepRun,
  instances: readonly (GraphItem | undefined)[],
  escalated: ReadonlySet<string> | undefined,
  standIns: ReadonlyMap<string, number> | undefined
): void {
  if (step.kind !== 'review' || !step.forEach || scope.web) {
    return
  }
  const valueOf = (id: string) => {
    const outcome = scope.outcomes.get(id)
    return outcome && 'value' in outcome ? outcome.value : undefined
  }
  const verified = instances.flatMap((item) => {
    const all = item ? run.calls.filter((view) => view.itemKey === item.key) : []
    if (!item || !all.length || all.some((view) => view.status === 'ready')) {
      return []
    }
    const views = graphCountedViews(scope, step, item, all, standIns)
    // Not escalated: its one review is the first (or its stand-in's), and one that wants more
    // waits for the step.
    const first = scope.outcomes.get(views[0]!.id)!
    if (
      escalated &&
      !escalated.has(item.key) &&
      graphWantsEscalation(
        step,
        item,
        first,
        graphFirstReview(scope, step, item).independent,
        graphUsesLegacyVerification(scope)
      )
    ) {
      return []
    }
    const target = graphReviewedTarget(scope, step, item, views, valueOf)
    return target.tally === 'confirmed' ? [target] : []
  })
  if (verified.length) {
    run.verifiedEarly = verified
  }
}
