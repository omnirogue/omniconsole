import { isIndependentLineage } from '../../../../shared/model-lineage'
import { councilFinalCheckSteps } from '../../../../shared/workflow-council-final-check'
import {
  DECIDE_FALLBACK_SKEPTIC_ROUND,
  DECIDE_SKEPTIC_ROUND,
  type DecideSkeptic
} from '../../../../shared/workflow-decide-guard'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import { finalCheckDefender } from './graph-council-final-check'
import { graphFrameLimits } from './graph-frame-limits'
import { graphDoneCallIds, type GraphStepRun } from './graph-plan-types'
import type { GraphScope } from './graph-scope'
import { runGraphStep } from './graph-step'
import { graphCallId } from './graph-step-calls'
import { graphWithheldDecision } from './graph-decide-withheld'

export const DECIDE_SKEPTIC_INSTRUCTION =
  "You are the skeptic. Check the recommendation below (under the final step's title) against every hard limit in the frame: does it, as written, break any of them or quietly drop one? For each problem, quote the limit and the recommendation's words. VERDICT: PASS only if it keeps every hard limit; VERDICT: FAIL if it breaks or drops one; VERDICT: UNSURE if you cannot tell."

export const DECIDE_SKEPTIC_FRAME_INSTRUCTION =
  "You are the skeptic. The frame does not list its hard limits clearly, so read the whole frame and find every limit it states or implies (budget, time, law, place, what must not change). Check the recommendation below (under the final step's title) against each: does it, as written, break or quietly drop any? Quote the limit and the recommendation's words. VERDICT: PASS only if it keeps every one; VERDICT: FAIL if it breaks or drops one; VERDICT: UNSURE if you cannot tell."

type Check =
  | { state: 'pending' }
  | { state: 'pass' | 'fail'; texts: string[] }
  | { state: 'unknown'; why: NonNullable<DecideSkeptic['why']> }

/**
 * Decide's skeptic, after the blind final check picked what to show: one judge of a family other
 * than that text's writer checks it against the frame's hard limits (the whole frame when they are
 * not listed). A memo it rejects gives way to the best finalist only if the finalist passes too;
 * a known failure is never shown as the recommendation, and an unknown one is shown unchecked.
 */
export function settleDecideGuard(
  scope: GraphScope,
  step: WorkflowStep,
  chair: GraphStepRun
): void {
  const check = councilFinalCheckSteps(scope.config.spec)
  const source = scope.config.spec.finalCheck?.skeptic
  const guard = chair.finalCheck
  const memo = chair.texts?.[0]
  if (!check || source === undefined || step.id !== check.chair.id || !guard || !memo) {
    return
  }
  if (chair.state === 'active') {
    return
  }
  const finalist = finalCheckDefender(scope, check.rank.id).first
  const shipsFinalist = guard.result === 'first-opinion'
  const set = (skeptic: DecideSkeptic) => {
    guard.skeptic = skeptic
  }
  if (guard.result === 'finished-early') {
    return set({ shipped: 'memo', status: 'unchecked', why: 'finished-early' })
  }
  const frame = scope.outputOf(source)
  const limits = graphFrameLimits(
    frame.status === 'ok' ? frame.run.texts?.[0]?.markdown : undefined
  )
  if (limits.state === 'none') {
    return set({ shipped: shipsFinalist ? 'finalist' : 'memo', status: 'no-limits' })
  }
  const against = limits.state === 'listed' ? 'limits' : 'frame'
  const review = (round: number, text: string, writerSeat: string | undefined): Check => {
    const writer = scope.config.seats.find((seat) => seat.id === writerSeat)?.lineage ?? 'unknown'
    const index = check.rank.agents.findIndex((_, agent) => {
      const seat = scope.config.seats.find((entry) => entry.id === scope.seatFor(check.rank, agent))
      return !!seat && isIndependentLineage(seat.lineage, writer)
    })
    if (index === -1) {
      return { state: 'unknown', why: 'no-seat' }
    }
    const reviewer: WorkflowStep = {
      id: check.rank.id,
      kind: 'review',
      title: `${check.chair.title} (skeptic)`,
      instruction:
        against === 'limits' ? DECIDE_SKEPTIC_INSTRUCTION : DECIDE_SKEPTIC_FRAME_INSTRUCTION,
      agents: check.rank.agents,
      inputs: [source, step.id]
    }
    const callId = graphCallId(reviewer, round, true, undefined, index)
    if (!scope.outcomes.has(callId) && scope.config.refused?.(callId)) {
      return { state: 'unknown', why: 'finished-early' }
    }
    const shown = { ...chair, texts: [{ ...memo, markdown: text }] }
    const run = runGraphStep(scope, reviewer, round, {
      inLoop: true,
      onlyAgent: index,
      overrides: new Map([
        [step.id, { status: 'ok', run: shown, callIds: graphDoneCallIds(chair) }]
      ])
    })
    scope.runs[check.rank.id].push(run)
    if (run.state === 'active' || run.state === 'waiting') {
      return { state: 'pending' }
    }
    const verdict = run.verdicts?.[index]
    if (verdict === 'pass' || verdict === 'fail') {
      return { state: verdict, texts: (run.texts ?? []).map((entry) => entry.markdown) }
    }
    return {
      state: 'unknown',
      why: run.calls.some((view) => view.skipped) ? 'finished-early' : 'failed'
    }
  }
  const shown = shipsFinalist ? finalist! : undefined
  const first = review(
    DECIDE_SKEPTIC_ROUND,
    shown ? shown.markdown : memo.markdown,
    shown ? shown.seatId : memo.seatId
  )
  const shipped = shipsFinalist ? 'finalist' : 'memo'
  if (first.state === 'pending') {
    chair.state = 'active'
    return
  }
  if (first.state === 'pass') {
    return set({ shipped, status: 'kept', against })
  }
  if (first.state === 'unknown') {
    return set({ shipped, status: 'unchecked', against, why: first.why })
  }
  const finalists = scope.runs[check.rank.id][0]?.candidates ?? []
  const withhold = (
    reasons: string[],
    rejected: Pick<DecideSkeptic, 'memoRejected' | 'finalistRejected'>
  ) => {
    chair.finalCheckAnswer = graphWithheldDecision(reasons, finalists)
    set({ shipped: 'none', status: 'withheld', against, ...rejected })
  }
  if (shipsFinalist) {
    return withhold(first.texts, { finalistRejected: true })
  }
  if (!finalist) {
    return withhold(first.texts, { memoRejected: true })
  }
  // The memo broke a limit: the best finalist may stand in only once it passes the same check.
  const second = review(DECIDE_FALLBACK_SKEPTIC_ROUND, finalist.markdown, finalist.seatId)
  if (second.state === 'pending') {
    chair.state = 'active'
    return
  }
  if (second.state === 'fail') {
    return withhold([...first.texts, ...second.texts], {
      memoRejected: true,
      finalistRejected: true
    })
  }
  chair.finalCheckAnswer = finalist.markdown
  set({
    shipped: 'finalist',
    memoRejected: true,
    against,
    ...(second.state === 'unknown' ? { status: 'unchecked', why: second.why } : { status: 'kept' })
  })
}
