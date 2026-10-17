import { graphUsesLegacyVerification } from './graph-discover-rules'
export { graphUsesLegacyVerification } from './graph-discover-rules'
import type { WorkflowStep } from '../../../../shared/workflow-graph'
import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import type { WorkflowOneAnswerRoute } from '../../../../shared/workflow-one-answer'
import { councilSeatNames } from '../presets/council-ranking'
import type { GraphInputSection } from './graph-prompts'
import type {
  GraphCall,
  GraphConfig,
  GraphLoopState,
  GraphOkOutput,
  GraphOutcome,
  GraphStepOutput,
  GraphStepRun,
  GraphTask
} from './graph-plan-types'
import { GRAPH_JEV_SEAT_ID } from './graph-plan-types'
import { graphWebLegend, type GraphWebPlan } from './graph-web-plan'

/** Everything one planning pass reads and writes. */
export type GraphScope = {
  config: GraphConfig
  task: GraphTask
  outcomes: ReadonlyMap<string, GraphOutcome>
  byId: Map<string, WorkflowStep>
  runs: Record<string, GraphStepRun[]>
  outputs: Map<string, GraphStepOutput>
  calls: GraphCall[]
  notes: string[]
  loop?: GraphLoopState
  find?: WorkflowFindTrail
  route?: WorkflowOneAnswerRoute
  web?: GraphWebPlan
  nameOf: (seatId: string) => string
  seatFor: (step: WorkflowStep, agentIndex: number) => string
  title: (id: string) => string
  outputOf: (id: string, overrides?: Map<string, GraphStepOutput>) => GraphStepOutput
}

export function createGraphScope(
  config: GraphConfig,
  task: GraphTask,
  outcomes: ReadonlyMap<string, GraphOutcome>
): GraphScope {
  const byId = new Map(config.spec.steps.map((step) => [step.id, step]))
  const seatIds = new Set(config.seats.map((seat) => seat.id))
  const names = councilSeatNames(config.seats)
  const outputs = new Map<string, GraphStepOutput>()
  return {
    config,
    task,
    outcomes,
    byId,
    runs: Object.fromEntries(config.spec.steps.map((step) => [step.id, []])),
    outputs,
    calls: [],
    notes: [],
    nameOf: (seatId) =>
      seatId === GRAPH_JEV_SEAT_ID
        ? 'JEV'
        : (names[config.seats.findIndex((seat) => seat.id === seatId)] ?? seatId),
    seatFor: (step, agentIndex) => {
      const seatId = config.agentSeats[step.id]?.[agentIndex]
      if (!seatId || !seatIds.has(seatId)) {
        throw new Error(`Missing frozen seat for ${step.id} agent ${agentIndex + 1}`)
      }
      return seatId
    },
    title: (id) => byId.get(id)?.title ?? id,
    outputOf: (id, overrides) => overrides?.get(id) ?? outputs.get(id) ?? { status: 'pending' }
  }
}

/** How a settled step reads in a consumer's prompt; undefined when it has nothing to say. */
export function graphSection(
  scope: GraphScope,
  id: string,
  output: GraphOkOutput
): GraphInputSection | undefined {
  const step = scope.byId.get(id)!
  const run = output.run
  if (run.state === 'empty' && !run.items?.length && !run.targets?.length) {
    return undefined
  }
  if (step.kind === 'rank') {
    return {
      kind: 'ranking',
      title: step.title,
      standings: (run.standings ?? []).map((standing) => ({
        ...standing,
        name:
          run.candidates?.find((candidate) => candidate.label === standing.label)?.name ??
          standing.label
      })),
      ballots: run.texts ?? []
    }
  }
  if (step.kind === 'review' && step.forEach) {
    return {
      kind: 'targets',
      title: step.title,
      ...(graphUsesLegacyVerification(scope) ? { legacy: true as const } : {}),
      ...(step.escalate || step.forEach.screen ? { compact: true as const } : {}),
      // Older specs replay with the prompts they ran with, so the mark needs the newer option.
      ...(step.escalate?.crossFamily ? { oneReview: true as const } : {}),
      targets: (run.targets ?? []).map((target) => ({
        item: target.item,
        tally: target.tally,
        ...(target.unchecked ? { unchecked: true } : {}),
        ...(target.screened ? { screened: true } : {}),
        ...(target.resurfaced ? { resurfaced: true } : {}),
        ...(target.setAsideAt !== undefined ? { setAsideAt: target.setAsideAt } : {}),
        ...(target.sameFamilyOnly ? { sameFamilyOnly: true } : {}),
        ...(target.confirmedBy
          ? { confirmedBy: target.confirmedBy, jevVerify: target.jevVerify }
          : {}),
        ...(target.refutedBy ? { refutedBy: target.refutedBy, jevVerify: target.jevVerify } : {}),
        votes: target.votes.map((verdict, index) => ({
          name: scope.nameOf(scope.config.agentSeats[step.id][target.voters?.[index] ?? index]),
          verdict,
          ...(target.texts[index] ? { markdown: target.texts[index]! } : {})
        }))
      }))
    }
  }
  if (step.kind === 'review') {
    return {
      kind: 'reviews',
      title: step.title,
      reviews: (run.texts ?? []).map((text) => ({
        ...text,
        verdict: run.verdicts?.[text.agentIndex] ?? null
      })),
      ...(run.approved !== undefined ? { approved: run.approved } : {})
    }
  }
  const web = graphWebLegend(scope, id)
  if (step.list) {
    return {
      kind: 'items',
      title: step.title,
      items: run.items ?? [],
      ...(graphUsesLegacyVerification(scope) ? { legacy: true as const } : {}),
      ...(web ? { web } : {})
    }
  }
  return { kind: 'texts', title: step.title, texts: run.texts ?? [], ...(web ? { web } : {}) }
}

/** Publishes a step's run for the steps that read it. */
export function publishGraphStep(scope: GraphScope, step: WorkflowStep, run: GraphStepRun): void {
  scope.outputs.set(
    step.id,
    run.state === 'waiting' || run.state === 'active'
      ? { status: 'pending' }
      : run.state === 'failed' || run.state === 'not-run'
        ? { status: run.state, reason: run.reason ?? `${step.title} ${run.state}`, run }
        : {
            status: 'ok',
            run,
            callIds: run.calls.filter((view) => view.status === 'done').map((view) => view.id)
          }
  )
}
