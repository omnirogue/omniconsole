import { graphDiscoverVerifyAdmission } from './graph-discover-rules'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  planWorkflowGraph,
  type GraphCall,
  type GraphConfig,
  type GraphOutcome
} from './graph-plan'
import { FIND_RULES } from './graph-plan-types'
import { graphDecisionAdmission, graphDecisionRules } from './graph-decision-rules'

/** Shared by the graph planner's regression tests: three seats, one task, a driver. */
export const SEATS = (['claude', 'codex', 'grok'] as const).map(
  (agent) =>
    ({
      id: agent,
      agent,
      accountId: 'x',
      model: `${agent}-model`,
      effort: null,
      lineage: agent === 'claude' ? 'anthropic' : agent === 'codex' ? 'openai' : 'xai',
      policyRevision: 'p'
    }) as ResolvedLocalWorkflowSeat
)
export const task = { prompt: 'Question', evidence: '' }

export function configFor(spec: WorkflowSpec): GraphConfig {
  return {
    spec,
    ...graphDiscoverVerifyAdmission(spec),
    seats: SEATS,
    access: 'frozen',
    findRules: FIND_RULES,
    agentSeats: Object.fromEntries(
      spec.steps.map((step) => [
        step.id,
        step.agents.map((agent) => (agent.route === 'gemini' ? 'claude' : agent.route))
      ])
    )
  }
}

/** A run admitted today: its frozen decision rules, read back from the host the way the runner does. */
export const admittedDecisionRules = (spec: WorkflowSpec): Partial<GraphConfig> =>
  graphDecisionRules({ host: graphDecisionAdmission(spec) })

/** Drives the planner to the end, answering every ready call with `answer` (undefined = fail). */
export function drive(
  spec: WorkflowSpec,
  answer: (call: GraphCall) => unknown,
  change: Partial<GraphConfig> = {}
) {
  const config = { ...configFor(spec), ...change }
  const outcomes = new Map<string, GraphOutcome>()
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 50 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      const value = answer(call)
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return plan
}

export const text = (markdown: string) => ({ markdown })
