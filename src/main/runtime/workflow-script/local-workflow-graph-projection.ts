import type { GraphJevRecord } from './graph/graph-jev-store'
import type {
  LocalWorkflowGraphItem,
  LocalWorkflowGraphRound,
  LocalWorkflowGraphRun,
  LocalWorkflowGraphState,
  LocalWorkflowSeatView
} from '../../../shared/local-workflow-view'
import { localWorkflowModelLabel } from '../../../shared/local-workflow-model-label'
import {
  workflowFinishReserve,
  workflowTerminalCall,
  workflowTopology
} from '../../../shared/workflow-graph-topology'
import { councilSeatNames } from './presets/council-ranking'
import { planWorkflowGraph, type GraphOutcome, type GraphPlan } from './graph/graph-plan'
import { graphMergeLaterReports, type GraphItem } from './graph/graph-items'
import type { GraphStepRun, GraphTarget } from './graph/graph-plan-types'
import { graphWebSettle } from './graph/graph-web-citations'
import { graphResurfaced } from './graph/graph-triage'
import { graphItemView } from './local-workflow-graph-item-view'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import type {
  LocalWorkflowAttemptRecord,
  LocalWorkflowCallRecord
} from './local-workflow-call-projection'
import type { WorkflowLiveExecution } from './workflow-live-registry'
import type { WorkflowSpec } from '../../../shared/workflow-graph'
import { graphCallSuperseded } from './graph/graph-supersede'
import { localWorkflowVerifiedFindings } from './local-workflow-verified-findings'
import { graphSnapshotRules } from './graph/graph-snapshot-rules'
import { graphImproveFrontierCallSeat } from './graph/graph-improve-frontier'
import { graphSeatRules, graphSubstituteSeatId } from './graph/graph-seat-substitution'
import { projectContracts } from './graph/graph-contract-projection'
import { workflowWebTrail } from '../../../shared/workflow-web-trail'

type GraphSnapshot = LocalWorkflowHostSnapshot & {
  graph: NonNullable<LocalWorkflowHostSnapshot['graph']>
}

export function isGraphSnapshot(snapshot: LocalWorkflowHostSnapshot): snapshot is GraphSnapshot {
  return snapshot.graphProgramRevision !== undefined && !!snapshot.graph
}

/** `step[/r<round>][/<item>]/a<agent>` → the seat that agent runs on. */
export function graphCallSeatId(snapshot: GraphSnapshot, callId: string): string | undefined {
  const substitute = graphSubstituteSeatId(callId)
  if (substitute) {
    return substitute
  }
  const parts = callId.split('/')
  // A review's impact triage (`step[/rN]/impact`) runs on the step's first seat.
  const agent = parts.at(-1) === 'impact' ? ['', '0'] : /^a(\d+)$/.exec(parts.at(-1) ?? '')
  const seat = agent ? snapshot.graph.agentSeats[parts[0]]?.[Number(agent[1])] : undefined
  return seat ?? graphImproveFrontierCallSeat(snapshot.graph.frontierSeats, callId)
}

/** Model names as the planner writes them (repeated models numbered). */
export function graphSeatModelLabels(snapshot: GraphSnapshot): ReadonlyMap<string, string> {
  const names = councilSeatNames(snapshot.seats)
  return new Map(snapshot.seats.map((seat, index) => [seat.id, names[index]]))
}

const SETTLED_RUN_STATES = new Set([
  'completed',
  'failed',
  'cancelled',
  'recovery_required',
  'recovery_failed'
])

/**
 * The outcomes the program itself has seen: an accepted result, or a failure once the program
 * stopped trying that call. While the run is active that is when the call left the live registry.
 * Once it is settled every unaccepted call is final. While it is paused, a call is final only
 * when it used every persisted attempt or a later step was built without it; otherwise Resume
 * will try it again, so it shows as waiting.
 */
export function graphOutcomesFromRecords(input: {
  records: readonly LocalWorkflowCallRecord[]
  attempts: readonly LocalWorkflowAttemptRecord[]
  results: ReadonlyMap<string, unknown>
  live?: WorkflowLiveExecution
  active: boolean
  state: string
  attemptLimit: number
  spec: WorkflowSpec
  /** The run's host-answered calls (JEV ballots and checks); no agent record holds them. */
  jev?: Readonly<Record<string, GraphJevRecord>>
}): Map<string, GraphOutcome> {
  const outcomes = new Map<string, GraphOutcome>(
    Object.entries(input.jev ?? {}).map(([callId, record]) => [callId, record.outcome])
  )
  const recorded = input.records.map((record) => record.call_id)
  for (const record of input.records) {
    if (input.results.has(record.call_id)) {
      outcomes.set(record.call_id, { value: input.results.get(record.call_id) })
      continue
    }
    const attempts = input.attempts.filter((attempt) => attempt.call_id === record.call_id)
    const inFlight =
      input.live?.calls.has(record.call_id) ||
      attempts.some((attempt) => ['prepared', 'running'].includes(attempt.state))
    const final = input.active
      ? !inFlight
      : SETTLED_RUN_STATES.has(input.state) ||
        attempts.length >= input.attemptLimit ||
        graphCallSuperseded(input.spec, record.call_id, recorded)
    if (final) {
      outcomes.set(record.call_id, { failed: true })
    }
  }
  return outcomes
}

function stepState(run: GraphStepRun): LocalWorkflowGraphState {
  return run.state === 'active' ? 'running' : run.state
}

function projectRound(
  run: GraphStepRun,
  labels: ReadonlyMap<string, string>,
  projectItem: (item: GraphItem) => LocalWorkflowGraphItem,
  settle: (target: GraphTarget) => GraphTarget
): LocalWorkflowGraphRound {
  return {
    round: run.round,
    ...(run.finalCheck ? { finalCheck: run.finalCheck } : {}),
    state: stepState(run),
    ...(run.reason ? { reason: run.reason } : {}),
    calls: run.calls.map((view) => ({
      callId: view.id,
      agentIndex: view.agentIndex,
      ...(view.jev ? { jev: true as const } : {}),
      ...(view.itemKey ? { itemKey: view.itemKey } : {}),
      status: view.status === 'ready' ? 'waiting' : view.status,
      ...(view.verdict ? { verdict: view.verdict } : {}),
      ...(view.items !== undefined ? { items: view.items } : {})
    })),
    ...(run.texts?.length
      ? { labels: run.texts.map((text) => ({ callId: text.callId, label: text.label })) }
      : {}),
    ...(run.items
      ? {
          items: run.items.map((item) => ({
            ...projectItem(item),
            ...(item.parentKey ? { parentKey: item.parentKey } : {})
          }))
        }
      : {}),
    ...(run.targets
      ? {
          targets: run.targets.map(settle).map((target) => ({
            ...projectItem(target.item),
            tally: target.tally,
            ...(target.unchecked ? { unchecked: true } : {}),
            ...(target.screened ? { screened: true } : {}),
            ...(target.resurfaced ? { resurfaced: true as const } : {}),
            ...(target.setAsideAt !== undefined ? { setAsideAt: target.setAsideAt } : {}),
            ...(target.crossChecked ? { crossChecked: true } : {}),
            ...(target.sameFamilyOnly ? { sameFamilyOnly: true } : {}),
            ...(target.webChecks ? { webChecks: target.webChecks } : {}),
            ...(target.webUnbacked ? { webUnbacked: true as const } : {}),
            ...(target.jevVerify !== undefined ? { jevVerify: target.jevVerify } : {}),
            // A page left unbacked once every report merged in unsettles JEV's confirmation too.
            ...(target.confirmedBy && target.tally === 'confirmed'
              ? { confirmedBy: target.confirmedBy }
              : {}),
            ...(target.refutedBy && target.tally === 'refuted'
              ? { refutedBy: target.refutedBy }
              : {}),
            votes: target.votes
          }))
        }
      : {}),
    ...(run.approved !== undefined ? { approved: run.approved } : {}),
    ...(run.standings
      ? {
          standings: run.standings.map((standing) => ({
            label: standing.label,
            name:
              run.candidates?.find((candidate) => candidate.label === standing.label)?.name ??
              labels.get(standing.label) ??
              standing.label,
            averageRank: standing.averageRank,
            votes: standing.votes,
            place: standing.place
          }))
        }
      : {}),
    ...(run.criteria ? { criteria: run.criteria } : {}),
    ...(run.setAside ? { setAside: run.setAside } : {}),
    notes: run.notes
  }
}

/**
 * A finishing run refuses every new agent call outside its final step (graph-checkpoint.ts), and
 * the program settles each refused call as failed. Planning the same way reaches the final step
 * exactly as the program does; `recorded` are the calls that already have a record.
 */
function planWithRefusedCalls(
  config: Parameters<typeof planWorkflowGraph>[0],
  task: GraphSnapshot['task'],
  outcomes: ReadonlyMap<string, GraphOutcome>,
  recorded: ReadonlySet<string>
): GraphPlan {
  const finalStepId = workflowFinishReserve(config.spec)?.finalStepId
  const settled = new Map(outcomes)
  for (;;) {
    const plan = planWorkflowGraph(
      {
        ...config,
        refused: (id) =>
          !!config.refused?.(id) || (!recorded.has(id) && !workflowTerminalCall(config.spec, id))
      },
      task,
      settled
    )
    const refused = plan.ready.filter(
      (call) =>
        !call.jev &&
        !call.check &&
        !call.screen &&
        !call.route &&
        !call.web &&
        !recorded.has(call.id) &&
        !workflowTerminalCall(config.spec, call.id)
    )
    if (!finalStepId || !refused.length) {
      return plan
    }
    for (const call of refused) {
      settled.set(call.id, { failed: true, skipped: true })
    }
  }
}

/** The graph view of a run: the frozen spec, each step's rounds, and the plan's outcome. */
export function projectGraphRun(
  snapshot: GraphSnapshot,
  outcomes: ReadonlyMap<string, GraphOutcome>,
  active: boolean,
  /** Present once the run is finishing: the calls that already have a record. */
  finishing?: ReadonlySet<string>
): { graphRun: LocalWorkflowGraphRun; plan: GraphPlan } {
  const { spec, agentSeats } = snapshot.graph
  const config = {
    spec,
    seats: snapshot.seats,
    agentSeats,
    access:
      snapshot.access === 'workspace-read' ? ('workspace-read' as const) : ('frozen' as const),
    ...graphSnapshotRules(snapshot),
    ...graphSeatRules(snapshot)
  }
  const plan = finishing
    ? planWithRefusedCalls(config, snapshot.task, outcomes, finishing)
    : planWorkflowGraph(config, snapshot.task, outcomes)
  const names = graphSeatModelLabels(snapshot)
  const seatView = (seatId: string): LocalWorkflowSeatView => {
    const seat = snapshot.seats.find((entry) => entry.id === seatId)!
    return {
      seatId,
      agent: seat.agent,
      model: seat.model,
      modelLabel: names.get(seatId) ?? localWorkflowModelLabel(seat.agent, seat.model),
      effort: seat.effort
    }
  }
  const { level } = workflowTopology(spec)
  // An item shows every report of it, including those a later round made.
  const later = Object.values(plan.runs).flatMap((runs) =>
    runs.flatMap((run) => run.knownReports ?? [])
  )
  const merged = (item: GraphItem): GraphItem => {
    // Later reports of a repeat merged into this item are filed under the repeat's key.
    const keys = [item.key, ...(item.alsoMerged ?? [])]
    const reports = later
      .filter((entry) => keys.includes(entry.key))
      .map((entry) => ({ ...entry, key: item.key }))
    return reports.length ? graphMergeLaterReports([item], reports)[0]! : item
  }
  const projectItem = (item: GraphItem) => graphItemView(merged(item))
  // Settled on the item as shown, every later report merged in; the round's record is untouched.
  // A JEV set-aside a later report reached shows resurfaced, as the loop's aggregate lists it.
  const settle = (target: GraphTarget): GraphTarget => {
    const shown = graphResurfaced({ ...target, item: merged(target.item) }, target.item)
    const checked = plan.web ? graphWebSettle(plan.web, shown.item, shown) : shown
    return { ...checked, item: target.item }
  }
  const steps = spec.steps.map((step) => {
    const runs = plan.runs[step.id]
    const latest = runs.at(-1)!
    const inLoop = spec.repeat?.do === step.id || spec.repeat?.review === step.id
    const loopRunning = inLoop && plan.loop?.status === 'running'
    const state =
      loopRunning && latest.state !== 'waiting' ? ('running' as const) : stepState(latest)
    return {
      id: step.id,
      // A paused or stopped run is not working on anything, whatever it would do next.
      state: state === 'running' && !active ? ('waiting' as const) : state,
      ...(latest.reason ? { reason: latest.reason } : {}),
      agents: step.agents.map((agent, index) => ({
        ...seatView(agentSeats[step.id][index]),
        ...(agent.angle ? { angle: agent.angle } : {})
      })),
      rounds: runs.map((run) => projectRound(run, names, projectItem, settle))
    }
  })
  // Only the web call's record decides what the view says was read; a run without one shows none.
  const webCall = plan.calls.find((call) => call.web)
  return {
    plan,
    graphRun: {
      spec,
      levels: Object.fromEntries(spec.steps.map((step) => [step.id, level.get(step.id) ?? 0])),
      steps,
      ...(plan.loop ? { loop: plan.loop } : {}),
      ...(plan.find ? { find: plan.find } : {}),
      ...(plan.route ? { route: plan.route } : {}),
      ...(plan.outcome?.final?.ranking ? { ranking: plan.outcome.final.ranking } : {}),
      contracts: projectContracts(config),
      ...(plan.outcome?.final?.claims ? { claims: plan.outcome.final.claims } : {}),
      ...localWorkflowVerifiedFindings(spec, plan, settle, projectItem),
      ...(webCall ? { web: workflowWebTrail(spec, outcomes.get(webCall.id), active) } : {}),
      gaps: plan.outcome?.gaps ?? [],
      ...(plan.outcome?.degraded ? { degraded: plan.outcome.degraded } : {}),
      notes: plan.notes
    }
  }
}
