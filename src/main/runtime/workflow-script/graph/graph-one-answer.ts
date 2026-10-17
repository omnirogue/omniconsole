import textAnswerSchema from '../presets/schemas/text-answer.schema.json'
import {
  decideOneAnswerRoute,
  oneAnswerNote,
  oneAnswerSkipped,
  oneAnswerStep,
  type WorkflowOneAnswerRoute
} from '../../../../shared/workflow-one-answer'
import {
  GRAPH_JEV_SEAT_ID,
  type GraphCall,
  type GraphCallView,
  type GraphOutcome,
  type GraphRunOutcome
} from './graph-plan-types'
import { publishGraphStep, type GraphScope } from './graph-scope'
import { graphContractKey, graphRouteBand } from './graph-decision-rules'
import { runGraphStep } from './graph-step'

/** The route's own call id: host-answered, so it never gets an agent record. */
export const graphRouteCallId = (stepId: string) => `${stepId}/route`

/** JEV's reading as the run keeps it; anything else is a reading JEV could not give. */
function readRoute(outcome: GraphOutcome): { noul: number } | { failed: string } {
  const value = 'value' in outcome ? (outcome.value as { noul?: unknown; error?: unknown }) : null
  if (value && typeof value.noul === 'number') {
    return { noul: value.noul }
  }
  return {
    failed: value && typeof value.error === 'string' ? value.error : 'the JEV call failed'
  }
}

/**
 * Plans the one-answer route before anything else: pending until JEV has read the question, then
 * either the answer step alone (every other step not run) or the full workflow without it.
 */
export function planOneAnswerRoute(scope: GraphScope): WorkflowOneAnswerRoute | 'pending' {
  const { spec } = scope.config
  const step = oneAnswerStep(spec)!
  const call: GraphCall = {
    id: graphRouteCallId(step.id),
    prompt: '',
    schema: textAnswerSchema,
    output: 'text',
    seatId: GRAPH_JEV_SEAT_ID,
    dependencies: [],
    stepId: step.id,
    round: 1,
    agentIndex: step.agents.length + 1,
    route: { question: scope.task.prompt, ...graphContractKey(scope.config, 'route') },
    validateSemantics: () => null
  }
  scope.calls.push(call)
  const outcome = scope.outcomes.get(call.id)
  const view: GraphCallView = {
    id: call.id,
    stepId: step.id,
    round: 1,
    agentIndex: call.agentIndex,
    seatId: call.seatId,
    jev: true,
    status: outcome ? ('value' in outcome ? 'done' : 'failed') : 'ready'
  }
  if (!outcome) {
    scope.runs[step.id] = [{ stepId: step.id, round: 1, state: 'active', calls: [view], notes: [] }]
    return 'pending'
  }
  const decision = decideOneAnswerRoute(readRoute(outcome), graphRouteBand(scope.config))
  scope.route = decision
  scope.notes.push(oneAnswerNote(decision))
  const routed = decision.route === 'one-answer'
  if (!routed) {
    const skipped = { stepId: step.id, round: 1, calls: [view], notes: [] }
    scope.runs[step.id] = [{ ...skipped, state: 'not-run', reason: oneAnswerSkipped(false) }]
    publishGraphStep(scope, step, scope.runs[step.id][0])
    return decision
  }
  const run = runGraphStep(scope, step, 1)
  run.calls.unshift(view)
  scope.runs[step.id] = [run]
  publishGraphStep(scope, step, run)
  for (const other of spec.steps) {
    if (other.id !== step.id) {
      const reason = oneAnswerSkipped(true)
      scope.runs[other.id] = [
        { stepId: other.id, round: 1, state: 'not-run', reason, calls: [], notes: [] }
      ]
    }
  }
  return decision
}

/** How a routed run ends: the one answer with the route's note, or why there is none. */
export function graphOneAnswerOutcome(scope: GraphScope): GraphRunOutcome {
  const step = oneAnswerStep(scope.config.spec)!
  const run = scope.runs[step.id][0]
  const answer = run.texts?.[0]?.markdown ?? ''
  if ((run.state !== 'done' && run.state !== 'gaps') || !answer.trim()) {
    // Never the full workflow in its place: that would silently change a call a replay made.
    return {
      state: 'failed',
      error: `${step.title}: ${run.reason ?? 'the answer did not come back.'}`,
      gaps: []
    }
  }
  return {
    state: 'completed',
    gaps: run.state === 'gaps' ? [`${step.title}: ${run.reason}`] : [],
    final: { stepId: step.id, markdown: `${answer}\n\n${oneAnswerNote(scope.route!)}` }
  }
}
