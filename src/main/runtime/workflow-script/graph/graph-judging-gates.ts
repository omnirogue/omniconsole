import type { ContractRef } from '../../../../shared/decision-contracts/decision-contract-types'
import { councilFinalCheckSteps } from '../../../../shared/workflow-council-final-check'
import type { JevUsage } from '../../../structured-decisions/jev-certainty'
import {
  graphJevJudgmentOf,
  graphJudgingDigest,
  graphJudgingEntries,
  recordGraphJudging
} from './graph-judging-record'
import {
  graphValueError,
  type GraphCallView,
  type GraphConfig,
  type GraphOutcome,
  type GraphPlan,
  type GraphStepRun,
  type GraphTask,
  type GraphVerifyRequest
} from './graph-plan-types'
import { graphJevCallId } from './graph-step-calls'
import { graphJevVerifyMembers, graphJevVerifyProbabilities } from './graph-jev-verify-plan'

/**
 * A gate line of the judging record: one decision JEV made that is not a Rank round's ballot.
 * `decision` is the gate's answer in the words the run uses; `jev` says whether JEV answered.
 */
export type GraphJudgingGate = {
  kind: 'gate'
  at: number
  executionId: string
  template: string
  stepId: string
  round: number
  gate: 'set-aside' | 'shortlist' | 'route' | 'final-check' | 'verify'
  callId: string
  taskDigest: string
  contract?: ContractRef
  decision: string
  /** Why the gate decided that, when the run said (a route's reason, a shortlist's gap). */
  reason?: string
  /**
   * A screen: how many options JEV was shown, how many it scored, how many it set aside. A live
   * verify: also how many items the reviewers left unverified that JEV confirmed or refuted.
   */
  counts?: {
    items: number
    scored: number
    setAside?: number
    confirmed?: number
    refuted?: number
  }
  /** A verify: JEV's probability that each item is real, by item key. */
  probabilities?: Record<string, number>
  /** A live verify: the probability it confirmed at, and the keys it confirmed. */
  confirmAt?: number
  confirmed?: string[]
  /** A live verify (from @3): the probability it set aside at, and the keys it refuted. */
  rejectAt?: number
  refuted?: string[]
  /** A live verify: each root-cause merged finding it decided, with every member's probability. */
  members?: Record<string, Record<string, number>>
  /** A live verify: each finding it held undecided, and the merged reports JEV did not read. */
  unread?: Record<string, number>
  jev: {
    status: 'done' | 'failed' | 'skipped'
    method?: string
    usage?: JevUsage
    unsureReason?: string
    durationMs?: number
    /** A route: JEV's probability that the question has one right answer. */
    noul?: number
    model?: string
    detail?: string
  }
}

type Value = Record<string, unknown> | null

type GraphVerifyTotals = { jevConfirmed?: number; jevRefuted?: number }
const addCount = (total: number | undefined, count: number | undefined) =>
  count === undefined ? total : (total ?? 0) + count

/** Live verify lines' confirmations and set-asides added up; each absent until a line counts it. */
export function graphGateVerifyTotals(
  totals: GraphVerifyTotals | undefined,
  line: GraphJudgingGate
): GraphVerifyTotals {
  const jevConfirmed = addCount(totals?.jevConfirmed, line.counts?.confirmed)
  const jevRefuted = addCount(totals?.jevRefuted, line.counts?.refuted)
  return {
    ...(jevConfirmed !== undefined ? { jevConfirmed } : {}),
    ...(jevRefuted !== undefined ? { jevRefuted } : {})
  }
}

const valueOf = (outcome: GraphOutcome | undefined): Value =>
  outcome && 'value' in outcome && outcome.value && typeof outcome.value === 'object'
    ? (outcome.value as Record<string, unknown>)
    : null

/** How JEV answered a host call: from its outcome, and its view when nothing came back. */
function jevOf(view: GraphCallView | undefined, outcome: GraphOutcome | undefined) {
  const value = valueOf(outcome)
  const error = outcome ? graphValueError(outcome) : undefined
  const usage = value?.usage as JevUsage | undefined
  return {
    status: (view?.skipped
      ? 'skipped'
      : !outcome || 'failed' in outcome || error
        ? 'failed'
        : 'done') as GraphJudgingGate['jev']['status'],
    ...graphJevJudgmentOf(outcome),
    ...(usage && typeof usage.inputTokens === 'number' ? { usage } : {}),
    ...(typeof value?.noul === 'number' ? { noul: value.noul } : {}),
    ...(typeof value?.model === 'string' ? { model: value.model } : {}),
    ...(typeof value?.durationMs === 'number' ? { durationMs: value.durationMs } : {}),
    ...(error ? { detail: error } : {})
  }
}

function screenCounts(
  plan: GraphPlan,
  view: GraphCallView,
  run: GraphStepRun,
  outcome?: GraphOutcome
) {
  const request = plan.calls.find((call) => call.id === view.id)?.screen
  if (!request) {
    return {}
  }
  const scores = valueOf(outcome)?.scores
  const scored =
    scores && typeof scores === 'object'
      ? Object.values(scores as Record<string, unknown>).filter((score) => Number.isFinite(score))
          .length
      : 0
  const setAside = run.targets?.filter((target) => target.screened).length
  return {
    counts: {
      items: request.candidates.length,
      scored,
      ...(run.targets ? { setAside: setAside ?? 0 } : {})
    }
  }
}

/** A verify line's decision: @2's words while it only confirms, set-asides named first from @3. */
function verifyDecision(
  answered: boolean,
  request: GraphVerifyRequest,
  confirmed: readonly string[],
  refuted: readonly string[]
): string {
  if (!answered) {
    return 'not recorded'
  }
  if (request.confirmAt === undefined && request.rejectAt === undefined) {
    return 'recorded'
  }
  if (request.rejectAt === undefined) {
    return confirmed.length ? 'confirmed' : 'none confirmed'
  }
  if (refuted.length) {
    return confirmed.length ? 'set aside and confirmed' : 'set aside'
  }
  return confirmed.length ? 'confirmed' : 'none set aside'
}

/** Every gate a settled plan decided, one line each; a gate JEV never reached is left out. */
export function graphJudgingGates(
  config: GraphConfig,
  task: GraphTask,
  plan: GraphPlan,
  executionId: string,
  at: number,
  outcomes: ReadonlyMap<string, GraphOutcome>
): GraphJudgingGate[] {
  const { spec } = config
  const base = (
    stepId: string,
    round: number,
    gate: GraphJudgingGate['gate'],
    callId: string,
    contract: ContractRef | undefined
  ) => ({
    kind: 'gate' as const,
    at,
    executionId,
    template: spec.template,
    stepId,
    round,
    gate,
    callId,
    taskDigest: graphJudgingDigest(task.prompt),
    ...(contract ? { contract } : {})
  })
  const gates: GraphJudgingGate[] = []
  for (const step of spec.steps) {
    const screen = step.forEach?.screen
    if (!screen || (step.kind !== 'review' && !screen.shortlist)) {
      continue
    }
    const gate = screen.shortlist ? 'shortlist' : 'set-aside'
    for (const run of plan.runs[step.id] ?? []) {
      const view = run.calls.find((entry) => entry.jev && entry.id.endsWith('/screen'))
      if (!view || view.status === 'ready') {
        continue
      }
      const outcome = outcomes.get(view.id)
      const contract = plan.calls.find((call) => call.id === view.id)?.screen?.contract
      const jev = jevOf(view, outcome)
      gates.push({
        ...base(step.id, run.round, gate, view.id, contract),
        decision:
          jev.status !== 'done'
            ? 'not screened'
            : gate === 'shortlist' && run.unranked
              ? 'shortlist inconclusive'
              : gate === 'shortlist'
                ? 'shortlisted'
                : 'screened',
        ...(run.unranked ? { reason: run.unranked } : {}),
        ...screenCounts(plan, view, run, outcome),
        jev
      })
    }
  }
  for (const step of spec.steps.filter((entry) => entry.jevVerify)) {
    for (const run of plan.runs[step.id] ?? []) {
      const outcome = run.jevVerifyCall ? outcomes.get(run.jevVerifyCall) : undefined
      const request = plan.calls.find((call) => call.id === run.jevVerifyCall)?.verify
      if (!outcome || !request) {
        continue
      }
      const probabilities = graphJevVerifyProbabilities(outcome) ?? {}
      const jev = jevOf(undefined, outcome)
      const confirms = request.confirmAt !== undefined
      const rejects = request.rejectAt !== undefined
      const keysBy = (by: 'confirmedBy' | 'refutedBy') =>
        (run.targets ?? [])
          .filter((target) => target[by] === 'jev')
          .map((target) => target.item.key)
      const confirmed = keysBy('confirmedBy')
      const refuted = keysBy('refutedBy')
      const members = graphJevVerifyMembers(run.targets ?? [], probabilities)
      gates.push({
        ...base(step.id, run.round, 'verify', run.jevVerifyCall!, request.contract),
        decision: verifyDecision(jev.status === 'done', request, confirmed, refuted),
        counts: {
          items: request.items.length,
          scored: request.items.filter((item) => Number.isFinite(probabilities[item.key])).length,
          ...(confirms ? { confirmed: confirmed.length } : {}),
          ...(rejects ? { refuted: refuted.length } : {})
        },
        probabilities,
        ...(confirms ? { confirmAt: request.confirmAt, confirmed } : {}),
        ...(rejects ? { rejectAt: request.rejectAt, refuted } : {}),
        ...(members ? { members } : {}),
        ...(run.jevHeld ? { unread: run.jevHeld } : {}),
        jev
      })
    }
  }
  const routeStep = spec.oneAnswer?.step
  const route = plan.route
  if (routeStep && route) {
    const view = plan.runs[routeStep]?.[0]?.calls.find((entry) => entry.id === `${routeStep}/route`)
    const call = plan.calls.find((entry) => entry.id === `${routeStep}/route`)
    if (view && view.status !== 'ready') {
      gates.push({
        ...base(routeStep, 1, 'route', view.id, call?.route?.contract),
        decision: route.route,
        reason: route.reason,
        jev: {
          ...jevOf(view, outcomes.get(view.id)),
          ...(route.detail ? { detail: route.detail } : {})
        }
      })
    }
  }
  const check = councilFinalCheckSteps(spec)
  const verdict = check ? plan.runs[check.chair.id]?.[0]?.finalCheck : undefined
  if (check && verdict) {
    const callId = graphJevCallId(check.rank, 2, true)
    const judge = plan.runs[check.rank.id]?.find((run) => run.round === 2)
    const view = judge?.calls.find((entry) => entry.id === callId)
    const call = plan.calls.find((entry) => entry.id === callId)
    gates.push({
      ...base(check.chair.id, 2, 'final-check', callId, call?.jev?.contract),
      decision: verdict.result,
      reason: `judged by ${verdict.judgedBy.length ? verdict.judgedBy.join(' and ') : 'nobody'}`,
      jev: jevOf(view, outcomes.get(callId))
    })
  }
  return gates
}

/** Writes a settled run's judging record: every round's judgments and every JEV gate. */
export function recordSettledGraphJudging(
  snapshot: Pick<GraphConfig, 'seats'> & {
    graph: Pick<GraphConfig, 'spec' | 'agentSeats'>
    task: GraphTask
  },
  executionId: string,
  plan: GraphPlan,
  outcomes: ReadonlyMap<string, GraphOutcome>
): void {
  const config = {
    spec: snapshot.graph.spec,
    seats: snapshot.seats,
    agentSeats: snapshot.graph.agentSeats,
    access: 'frozen' as const
  }
  const at = Date.now()
  const { task } = snapshot
  recordGraphJudging(
    [
      ...graphJudgingEntries(config, task, plan, executionId, at, outcomes),
      ...graphJudgingGates(config, task, plan, executionId, at, outcomes)
    ],
    executionId
  )
}
