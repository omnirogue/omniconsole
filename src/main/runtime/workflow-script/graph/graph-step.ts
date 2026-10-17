import type { WorkflowStep } from '../../../../shared/workflow-graph'
import type { GraphItem } from './graph-items'
import type { GraphInputSection, GraphReviewText } from './graph-prompts'
import {
  graphPlural,
  graphStepIsAdvisory,
  type GraphCallView,
  type GraphCandidate,
  type GraphImproveBrief,
  type GraphOkOutput,
  type GraphStepOutput,
  type GraphStepRun
} from './graph-plan-types'
import { graphUsesLegacyVerification, graphSection, type GraphScope } from './graph-scope'
import { buildGraphCall, buildGraphJevCall, graphRankCandidates } from './graph-step-calls'
import { deriveGraphStep } from './graph-step-derive'
import { graphEscalations, graphUncheckedTarget } from './graph-triage'
import { graphStandIns } from './graph-stand-ins'
import { graphFirstReviewer } from './graph-first-reviewer'
import { graphAttachJevVerify, graphOrderForEach } from './graph-verify-order'
import { graphNotClose } from './graph-close'
import { graphEvidenceForEach } from './graph-evidence-plan'
import { graphWebForStep } from './graph-web-plan'
import { graphWebTarget } from './graph-web-citations'
import { graphCheckedOrder, graphSortForEach } from './graph-checked-order'
import { graphAttachVerifiedEarly } from './graph-review-target'

export type GraphStepExtras = {
  inLoop?: boolean
  /** Inputs to read from somewhere other than the published outputs (a repeat's current round). */
  overrides?: Map<string, GraphStepOutput>
  /** For each over these items instead of the for-each source's published list. */
  forItems?: GraphItem[]
  mergeCandidates?: GraphItem[]
  priorityKeys?: Set<string>
  revise?: { previous: string; reviews: GraphReviewText[] }
  known?: GraphItem[]
  /** Improve: each improver's brief, by agent index. */
  improve?: GraphImproveBrief[]
  /** Improve's frontier round: the seat each improver moves to, by agent index (none: its own). */
  frontier?: readonly (string | undefined)[]
  /** Rank: these candidates instead of the inputs' answers (Improve adds the best so far). */
  candidates?: GraphCandidate[]
  /** Rank in Improve: the task as the judges read it, with what every version must follow. */
  judgeTask?: string
  /** Rank in Improve: the best version's label, which JEV's top answer must clearly beat. */
  incumbent?: string
  /** Only this agent runs (Decide's skeptic: the seat independent of the writer). */
  onlyAgent?: number
  /** Rank: every judge sees its usual order reversed. */
  reverse?: true
  /** Rank with JEV: the decision point its ballot judges, when not the step's own ballot. */
  decisionPoint?: string
}

/**
 * One step in one round: waiting while an input is unsettled, not run when a required input
 * failed, otherwise its calls, and once they all settled, its outputs and state.
 */
export function runGraphStep(
  scope: GraphScope,
  step: WorkflowStep,
  round: number,
  extras: GraphStepExtras = {}
): GraphStepRun {
  const run: GraphStepRun = { stepId: step.id, round, state: 'waiting', calls: [], notes: [] }
  const inputs = step.inputs.map((id) => ({ id, output: scope.outputOf(id, extras.overrides) }))
  if (inputs.some((input) => input.output.status === 'pending')) {
    return run
  }
  const blocked = inputs.find(
    (input) =>
      input.output.status === 'not-run' ||
      (input.output.status === 'failed' && !graphStepIsAdvisory(scope.byId.get(input.id)))
  )
  if (blocked) {
    run.state = 'not-run'
    run.reason = `Not run: ${scope.title(blocked.id)} ${blocked.output.status === 'failed' ? 'failed' : 'did not run'}.`
    return run
  }
  const notClose = step.whenClose ? graphNotClose(scope, step.whenClose) : undefined
  if (notClose) {
    return { ...run, state: 'empty', reason: notClose }
  }
  const web = graphWebForStep(scope, step, run)
  if (web === 'pending' || web === 'failed') {
    return run
  }
  for (const input of inputs) {
    if (input.output.status === 'failed') {
      run.notes.push(`${step.title} went on without ${scope.title(input.id)}, which failed.`)
    }
  }
  // A failed review for each item still lists its items, every one unverified.
  const settled = inputs.flatMap((input): { id: string; output: GraphOkOutput }[] => {
    const { output } = input
    if (output.status === 'ok') {
      return [{ id: input.id, output }]
    }
    return output.status === 'failed' && output.run?.targets?.length
      ? [{ id: input.id, output: { status: 'ok', run: output.run, callIds: [] } }]
      : []
  })
  const dependencies = [
    ...new Set([...settled.flatMap((input) => input.output.callIds), ...(web ? [web.callId] : [])])
  ].sort()

  let instances: (GraphItem | undefined)[] = [undefined]
  let unchecked: GraphItem[] = []
  let screenedOut: GraphItem[] = []
  const where = `${step.title}${extras.inLoop ? ` round ${round}` : ''}`
  if (step.forEach) {
    const source =
      extras.forItems ??
      settled.find((input) => input.id === step.forEach!.step)?.output.run.items ??
      []
    const forEachInput = { step, round, inLoop: !!extras.inLoop, source, dependencies, run, where }
    const legacyEvidence = graphUsesLegacyVerification(scope)
      ? graphEvidenceForEach(scope, forEachInput)
      : undefined
    const order = graphOrderForEach(scope, {
      ...forEachInput,
      sorted: graphSortForEach(source),
      settled,
      candidates: extras.mergeCandidates
    })
    if (order.pending || legacyEvidence?.pending) {
      run.state = 'active'
      return run
    }
    const { screening } = order
    const checked = graphCheckedOrder(
      scope,
      forEachInput,
      order.sorted,
      extras.mergeCandidates,
      extras.priorityKeys,
      legacyEvidence
    )
    const { evidence, sorted } = checked
    if (evidence.pending) {
      run.state = 'active'
      return run
    }
    screenedOut = order.screenedOut.map(evidence.attach)
    if (order.unranked) {
      run.unranked = order.unranked
    }
    instances = sorted.slice(0, step.forEach.limit)
    unchecked = [...sorted.slice(step.forEach.limit), ...evidence.dropped]
    run.setAside = unchecked.length - evidence.dropped.length
    if (run.setAside) {
      run.notes.push(
        `${where}: ${graphPlural(run.setAside, 'item was', 'items were')} over the limit of ${step.forEach.limit} (the ${order.impact ? 'least important' : screening ? 'lowest-scored' : 'lowest-severity'} ones went last)${step.kind === 'review' ? ' and are carried on unverified' : ''}.`
      )
    }
    if (!instances.length) {
      run.state = 'empty'
      run.reason =
        order.empty ??
        evidence.empty(screenedOut.length) ??
        (screenedOut.length
          ? `Nothing to check: JEV set aside all ${screenedOut.length} items as non-findings.`
          : `Nothing to do: ${scope.title(step.forEach.step)} listed no items.`)
      run.targets = [...unchecked, ...screenedOut].map((item) =>
        graphWebTarget(scope, graphUncheckedTarget(step, item, screenedOut.includes(item)))
      )
      graphAttachJevVerify(scope, step, run)
      return run
    }
  }

  const sections = settled
    .filter((input) => input.id !== step.forEach?.step)
    .map((input) => graphSection(scope, input.id, input.output))
    .filter((entry): entry is GraphInputSection => !!entry)

  const candidates =
    step.kind === 'rank' ? (extras.candidates ?? graphRankCandidates(scope, settled)) : []
  if (step.kind === 'rank') {
    run.candidates = candidates
    if (candidates.length < 2) {
      run.state = 'empty'
      run.reason = `Nothing to rank: only ${graphPlural(candidates.length, 'answer')} came back.`
      return run
    }
  }

  const cuts = new Set<string>()
  // JEV judges a whole Rank step once; with `only`, the agents judge just when JEV could not.
  const jevCall =
    step.kind === 'rank' && step.jev && !step.forEach
      ? buildGraphJevCall(scope, {
          step,
          round,
          inLoop: !!extras.inLoop,
          candidates,
          dependencies,
          ...(extras.judgeTask ? { task: extras.judgeTask } : {}),
          ...(extras.incumbent ? { incumbent: extras.incumbent } : {}),
          ...(extras.decisionPoint ? { decisionPoint: extras.decisionPoint } : {})
        })
      : undefined
  const jevOutcome = jevCall ? scope.outcomes.get(jevCall.id) : undefined
  const jevFailed = !!jevOutcome && !('value' in jevOutcome)
  // JEV first: the model judges step in when JEV could not judge or was not sure.
  const jevUnsure =
    !!jevOutcome &&
    'value' in jevOutcome &&
    (jevOutcome.value as { unsure?: unknown } | null)?.unsure === true
  const agentsJudge = !jevCall || !step.jev?.only || jevFailed || jevUnsure
  if (jevCall && step.jev?.only && (jevFailed || jevUnsure)) {
    run.notes.push(
      `${step.title}${extras.inLoop ? ` round ${round}` : ''}: JEV ${jevFailed ? 'could not judge' : 'was not sure'}, so ${graphPlural(step.agents.length, 'model judge')} ranked${jevFailed ? ' instead' : ' too'}.`
    )
  }
  if (jevUnsure) {
    run.jevUnsure = true
  }
  const inLoop = !!extras.inLoop
  const standIns = graphStandIns(scope, step, round, inLoop, instances, run, where)
  const escalated = graphEscalations(scope, step, round, inLoop, instances, run, where, standIns)
  for (const item of agentsJudge ? instances : []) {
    step.agents.forEach((agent, agentIndex) => {
      const skip =
        escalated &&
        agentIndex !== graphFirstReviewer(scope, step, item) &&
        agentIndex !== standIns?.get(item!.key) &&
        !escalated.has(item!.key)
      if (skip || (extras.onlyAgent ?? agentIndex) !== agentIndex) {
        return
      }
      const built = buildGraphCall(scope, {
        step,
        round,
        inLoop: !!extras.inLoop,
        ...(item ? { item } : {}),
        agentIndex,
        sections,
        candidates,
        dependencies,
        ...(extras.revise ? { revise: extras.revise } : {}),
        ...(extras.known ? { known: extras.known } : {}),
        ...(extras.improve?.[agentIndex] ? { improve: extras.improve[agentIndex] } : {}),
        ...(extras.frontier?.[agentIndex] ? { frontierSeat: extras.frontier[agentIndex] } : {}),
        ...(web ? { web: web.pages } : {}),
        ...(extras.judgeTask ? { judgeTask: extras.judgeTask } : {}),
        ...(extras.reverse ? { reverse: true as const } : {})
      })
      built.cuts.forEach((cut) => cuts.add(cut))
      scope.calls.push(built.call)
      const outcome = scope.outcomes.get(built.call.id)
      const view: GraphCallView = {
        id: built.call.id,
        stepId: step.id,
        round,
        ...(item ? { itemKey: item.key } : {}),
        agentIndex,
        seatId: built.call.seatId,
        ...(agent.angle ? { angle: agent.angle } : {}),
        status: outcome ? ('value' in outcome ? 'done' : 'failed') : 'ready',
        ...(outcome && 'failed' in outcome && outcome.skipped ? { skipped: true as const } : {})
      }
      run.calls.push(view)
    })
  }
  if (jevCall) {
    scope.calls.push(jevCall)
    run.calls.push({
      id: jevCall.id,
      stepId: step.id,
      round,
      agentIndex: jevCall.agentIndex,
      seatId: jevCall.seatId,
      jev: true,
      status: jevOutcome ? ('value' in jevOutcome ? 'done' : 'failed') : 'ready',
      ...(jevOutcome && 'failed' in jevOutcome && jevOutcome.skipped
        ? { skipped: true as const }
        : {})
    })
  }
  if (cuts.size) {
    run.cuts = [...cuts]
    run.notes.push(...cuts)
  }
  // Every answer's citations are checked against the pages, so no step settles before them.
  if (run.calls.some((view) => view.status === 'ready') || (scope.web && !scope.web.outcome)) {
    run.state = 'active'
    graphAttachVerifiedEarly(scope, step, run, instances, escalated, standIns)
    return run
  }
  deriveGraphStep(scope, {
    step,
    run,
    round,
    inLoop: !!extras.inLoop,
    instances,
    unchecked,
    screenedOut,
    escalated,
    candidates,
    ...(extras.known ? { known: extras.known } : {}),
    ...(standIns?.size ? { standIns } : {})
  })
  return run
}
