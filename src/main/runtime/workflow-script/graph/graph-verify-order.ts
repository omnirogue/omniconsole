import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { graphSeverityRank, type GraphItem } from './graph-items'
import {
  GRAPH_ROOT_CAUSE_RULES,
  GRAPH_LEGACY_ROOT_CAUSE_RULES,
  graphImpactCallId,
  graphImpactProblem,
  graphImpactRows,
  graphImpactSchema,
  graphMergeRootCauses,
  graphMergesRootCauses
} from './graph-impact-answer'
import {
  graphPlural,
  graphValueError,
  type GraphCall,
  type GraphOkOutput,
  type GraphOutcome,
  type GraphStepRun
} from './graph-plan-types'
import { fitGraphPrompt } from './graph-prompts'
import { graphUsesLegacyVerification, type GraphScope } from './graph-scope'
import { graphScreenCall, graphTriage } from './graph-triage'
import { graphShortlistPlan } from './graph-frame-limits'
import { graphShortlist, type GraphShortlist } from './graph-shortlist'
import { graphWebFencer, graphWebRecordOutcome } from './graph-web-citations'
import { graphScoreLine } from './graph-decision-rules'
import { graphJevVerifyForEach } from './graph-jev-verify-plan'

export { graphAttachJevVerify } from './graph-jev-verify-plan'

/**
 * Which items a review for-each checks, in what order, and who checks each first. Measured on a
 * real Discover run (203 findings, 40 checks a round): JEV order left 40 of 73 high-impact
 * findings unchecked, severity order 23, a frontier impact triage 2. So JEV only sets aside
 * non-items; the order comes from the triage when it is on, else from severity.
 */

const IMPACT_DETAIL_CHARS = 600
const IMPACT_VARIANT_CHARS = 300
const IMPACT_VARIANT_TITLE_CHARS = 120

const oneLine = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)} …` : flat
}

/**
 * One frontier call that rates each item's impact before any reviewer runs. Every merged claim is
 * shown, since a severe variant makes the item severe; only the key is kept whole when it must fit.
 */
export function graphImpactCall(
  scope: GraphScope,
  input: {
    step: WorkflowStep
    round: number
    inLoop: boolean
    items: readonly GraphItem[]
    dependencies: string[]
    candidates?: readonly GraphItem[]
  }
): { call: GraphCall; cuts: string[] } {
  const { step, round, inLoop } = input
  const items = [...(input.candidates ?? []), ...input.items]
  const keys = items.map((item) => item.key)
  const merge = graphMergesRootCauses(step)
  const fitted = fitGraphPrompt(
    `${step.title} (impact triage)`,
    (budget) =>
      [
        `Goal: ${scope.task.prompt}`,
        `There are more results than can be checked. Rate the IMPACT of each one below, assuming it is true as described, so the most important are checked first.`,
        graphUsesLegacyVerification(scope)
          ? '5 = severe (data loss, a security hole, an outage, silently wrong results for many). 4 = serious (breaks a real workflow for many, or a safeguard fails open). 3 = moderate (an edge case, one tool). 2 = minor (an annoyance, a misleading message). 1 = negligible, or not a real result.'
          : 'Rate value for this goal: 5 = transformative or prevents severe harm for many; 4 = substantial gain in a real workflow; 3 = useful but bounded gain; 2 = small improvement; 1 = negligible value. For defects consider harm avoided; for proposals consider expected benefit, reach and feasibility.',
        'Judge impact only, not whether it is true. A result merged from several reports is as severe as its most severe report. Work only from this list; do not open files. Rate every key exactly once, with a why of at most 15 words.',
        merge
          ? graphUsesLegacyVerification(scope)
            ? GRAPH_LEGACY_ROOT_CAUSE_RULES
            : GRAPH_ROOT_CAUSE_RULES
          : '',
        `RESULTS (${items.length}):\n${items
          .map((item) => {
            const primary = [
              `(${item.severity}) ${item.title}`,
              `  at: ${item.location || 'no location'}`,
              `  ${oneLine(item.detail, IMPACT_DETAIL_CHARS)}`
            ].join('\n')
            // Each merged claim keeps its own line and share, so a long primary never hides it.
            const variants = (item.alsoReported ?? []).map(
              (other, at) =>
                `  also reported as (${other.severity}) ${oneLine(other.title, IMPACT_VARIANT_TITLE_CHARS)}: ${budget.take(`result ${item.key}, merged report ${at + 1}`, oneLine(other.detail, IMPACT_VARIANT_CHARS))}`
            )
            const taken = budget.take(`result ${item.key}`, primary)
            return `[${item.key}] ${budget.fence([taken, ...variants].join('\n'))}`
          })
          .join('\n\n')}`
      ]
        .filter(Boolean)
        .join('\n\n'),
    graphWebFencer(scope)
  )
  return {
    call: {
      id: graphImpactCallId(step, round, inLoop),
      prompt: fitted.prompt,
      schema: graphImpactSchema(merge),
      seatId: scope.seatFor(step, 0),
      dependencies: input.dependencies,
      stepId: step.id,
      round,
      agentIndex: 0,
      validateSemantics: (value) =>
        graphImpactProblem(value, keys, merge, graphUsesLegacyVerification(scope))
    },
    cuts: fitted.cuts
  }
}

const bySeverity = (left: GraphItem, right: GraphItem) =>
  graphSeverityRank(left.severity) - graphSeverityRank(right.severity)

/** The items most important first; a failed triage falls back to severity, never to JEV. */
export function graphImpactOrder(
  where: string,
  items: readonly GraphItem[],
  outcome: GraphOutcome,
  merge = false,
  candidates: readonly GraphItem[] = []
): { ordered: GraphItem[]; note: string } {
  const rows = 'value' in outcome ? graphImpactRows(outcome.value) : undefined
  if (!rows) {
    return {
      ordered: [...items].sort(bySeverity),
      note: `${where}: the impact triage did not answer, so the reviewers took the results by severity.`
    }
  }
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const rated = items.map((item) => {
    const row = byKey.get(item.key)
    return row
      ? { ...item, impact: { score: row.impact, why: row.why } }
      : {
          ...item,
          impact: {
            score: Math.max(1, 5 - graphSeverityRank(item.severity)),
            why: 'Not rated; severity fallback.'
          }
        }
  })
  const all = [...candidates, ...rated]
  const repeats = merge ? graphMergeRootCauses(all, rows) : { items: rated, merged: 0 }
  const current = new Set(items.map((item) => item.key))
  repeats.items = repeats.items.filter(
    (item) => current.has(item.key) || item.alsoMerged?.some((key) => current.has(key))
  )
  const scored = repeats.items.map((item, index) => ({ item, index }))
  const impact = (item: GraphItem) => item.impact?.score ?? 0
  const ordered = scored
    .sort(
      (left, right) =>
        impact(right.item) - impact(left.item) ||
        bySeverity(left.item, right.item) ||
        left.index - right.index
    )
    .map((entry) => entry.item)
  const high = ordered.filter((item) => impact(item) >= 4).length
  return {
    ordered,
    note: `${where}: a frontier triage rated ${graphPlural(items.length, 'result')} by impact (${high} high)${repeats.merged ? `, merged ${graphPlural(repeats.merged, 'repeat')} of an earlier result's root cause into it` : ''}, and the reviewers took them most important first.`
  }
}

/**
 * The for-each's items in checking order, after the JEV screen and the impact triage. `pending`
 * when a host screen or the triage has not answered yet: the step waits for it.
 */
export function graphOrderForEach(
  scope: GraphScope,
  input: {
    step: WorkflowStep
    round: number
    inLoop: boolean
    source: readonly GraphItem[]
    sorted: GraphItem[]
    settled: readonly { id: string; output: GraphOkOutput }[]
    dependencies: string[]
    run: GraphStepRun
    where: string
    candidates?: readonly GraphItem[]
  }
): {
  sorted: GraphItem[]
  screenedOut: GraphItem[]
  screening: boolean
  impact: boolean
  pending: boolean
  /** A Decide shortlist's gap and empty reason (graph-shortlist.ts). */
  unranked?: string
  empty?: string
} {
  const { step, round, inLoop, source, run, where } = input
  // Planned over every item; only live mode waits for it, once the reviewers are done.
  graphJevVerifyForEach(scope, input)
  let sorted = input.sorted
  let screenedOut: GraphItem[] = []
  const shortlist = !!step.forEach?.screen?.shortlist
  const screening =
    (step.kind === 'review' || shortlist) && !!step.forEach?.screen && source.length > 0
  if (screening) {
    const plan = shortlist ? graphShortlistPlan(step, input.settled) : undefined
    const call = graphScreenCall(scope, {
      step,
      round,
      inLoop,
      items: source,
      settled: input.settled,
      dependencies: input.dependencies,
      ...(plan ? { rubric: plan.rubric } : {})
    })
    scope.calls.push(call)
    const outcome = scope.outcomes.get(call.id)
    run.calls.push({
      id: call.id,
      stepId: step.id,
      round,
      agentIndex: call.agentIndex,
      seatId: call.seatId,
      jev: true,
      status: outcome
        ? 'value' in outcome && !graphValueError(outcome)
          ? 'done'
          : 'failed'
        : 'ready'
    })
    if (!outcome) {
      return { sorted, screenedOut, screening, impact: false, pending: true }
    }
    if (plan) {
      // Decide: the shortlist is the checking order, and nothing is set aside for review.
      const picked: GraphShortlist = graphShortlist(
        where,
        source,
        outcome,
        step.forEach!.limit,
        plan,
        graphScoreLine(scope.config, `${step.id}/shortlist`)
      )
      run.notes.push(picked.note)
      return {
        sorted: picked.ordered,
        screenedOut: [],
        screening,
        impact: false,
        pending: false,
        ...(picked.unranked ? { unranked: picked.unranked } : {}),
        ...(picked.empty ? { empty: picked.empty } : {})
      }
    }
    const triage = graphTriage(
      where,
      source,
      outcome,
      graphScoreLine(scope.config, `${step.id}/set-aside`)
    )
    // With the impact triage on, JEV only sets aside non-items; severity orders until it answers.
    sorted =
      step.forEach?.order === 'impact' ? [...triage.ordered].sort(bySeverity) : triage.ordered
    screenedOut = triage.setAside
    run.notes.push(triage.note)
  }
  // Merging repeats needs the triage whenever two results could be one; ordering, only past the limit.
  const impact =
    step.kind === 'review' &&
    step.forEach?.order === 'impact' &&
    (sorted.length > step.forEach.limit ||
      (graphMergesRootCauses(step) && sorted.length + (input.candidates?.length ?? 0) > 1))
  if (impact) {
    const { call, cuts } = graphImpactCall(scope, {
      step,
      round,
      inLoop,
      items: sorted,
      candidates: input.candidates,
      dependencies: input.dependencies
    })
    scope.calls.push(call)
    const outcome = scope.outcomes.get(call.id)
    run.calls.push({
      id: call.id,
      stepId: step.id,
      round,
      agentIndex: 0,
      seatId: call.seatId,
      status: outcome ? ('value' in outcome ? 'done' : 'failed') : 'ready',
      ...(outcome && 'failed' in outcome && outcome.skipped ? { skipped: true as const } : {})
    })
    if (!outcome) {
      return { sorted, screenedOut, screening, impact, pending: true }
    }
    graphWebRecordOutcome(scope, run, outcome)
    const ordered = graphImpactOrder(
      where,
      sorted,
      outcome,
      graphMergesRootCauses(step),
      input.candidates
    )
    sorted = ordered.ordered
    run.notes.push(ordered.note)
    if (cuts.length) {
      run.notes.push(
        `${where}: the impact triage was given ${graphPlural(cuts.length, 'shortened input')} to fit its prompt.`
      )
    }
  }
  return { sorted, screenedOut, screening, impact, pending: false }
}
