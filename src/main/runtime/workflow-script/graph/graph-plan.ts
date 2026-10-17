import { settleCouncilFinalCheck } from './graph-council-final-check'
import { workflowTopology } from '../../../../shared/workflow-graph-topology'
import { runFindBest } from './graph-find'
import { runGraphCompare } from './graph-compare'
import { settleDecideGuard } from './graph-decide-guard'
import { runGraphLoop } from './graph-loop'
import { planOneAnswerRoute } from './graph-one-answer'
import { graphOutcome } from './graph-outcome'
import { graphSeatOutcome } from './graph-seat-substitution'
import type { GraphConfig, GraphOutcome, GraphPlan, GraphTask } from './graph-plan-types'
import { createGraphScope, publishGraphStep } from './graph-scope'
import { graphWebOutcome, planGraphWebSources } from './graph-web-plan'
import { graphWebSettling } from './graph-web-citations'
import { runGraphStep } from './graph-step'

export type {
  GraphCall,
  GraphCallView,
  GraphConfig,
  GraphDegraded,
  GraphLoopState,
  GraphOutcome,
  GraphPlan,
  GraphRunOutcome,
  GraphStepRun,
  GraphStepState,
  GraphTask
} from './graph-plan-types'

/**
 * The deterministic planner behind every workflow graph run (docs/workflows/WORKFLOW-CORE-
 * 2026-09-22.md §7). Given the frozen spec and the outcomes of the calls settled so far, it says
 * which calls exist, which are ready, and what every step's state and output is. The program
 * launches what is ready and plans again after each settlement; the host projection plans over
 * the durable call rows. One function decides both, so the screen shows what actually runs.
 */
export function planWorkflowGraph(
  config: GraphConfig,
  task: GraphTask,
  outcomes: ReadonlyMap<string, GraphOutcome>
): GraphPlan {
  const scope = createGraphScope(config, task, outcomes)
  planGraphWebSources(scope)
  const { spec } = config
  const order = workflowTopology(spec).order ?? spec.steps.map((step) => step.id)
  const repeat = spec.repeat
  const inLoop = (id: string) => !!repeat && (repeat.do === id || repeat.review === id)
  const loopInputs = repeat
    ? [
        ...scope.byId.get(repeat.do)!.inputs,
        ...scope.byId.get(repeat.review)!.inputs.filter((input) => input !== repeat.do)
      ]
    : []
  const planned = new Set<string>()
  // One-answer routing decides first; the rest plans only when the question goes to it.
  const route = spec.oneAnswer ? planOneAnswerRoute(scope) : undefined
  const full = !route || (route !== 'pending' && route.route === 'full')
  if (spec.oneAnswer) {
    planned.add(spec.oneAnswer.step)
  }
  // Find the best runs its own pipeline over its two steps.
  if (spec.find && full) {
    runFindBest(scope)
  }
  // Fixpoint over the order: a step plans once its inputs are published; the loop runs once
  // every outside input of its two steps is.
  for (let progressed = full && !spec.find; progressed;) {
    progressed = false
    for (const id of order) {
      if (planned.has(id)) {
        continue
      }
      const ready = (inputs: readonly string[]) =>
        inputs.every((input) => scope.outputOf(input).status !== 'pending')
      if (inLoop(id)) {
        if (ready(loopInputs)) {
          runGraphLoop(scope)
          planned.add(repeat!.do)
          planned.add(repeat!.review)
          progressed = true
        }
        continue
      }
      const step = scope.byId.get(id)!
      if (ready(step.inputs)) {
        // A comparison by criterion plans a round per rubric line and publishes its own order.
        const runs = step.byCriterion
          ? runGraphCompare(scope, step)
          : [runGraphStep(scope, step, 1)]
        settleCouncilFinalCheck(scope, step, runs[0]!)
        settleDecideGuard(scope, step, runs[0]!)
        scope.runs[id] = runs
        if (!step.byCriterion) {
          publishGraphStep(scope, step, runs[0]!)
        }
        planned.add(id)
        progressed = true
      }
    }
  }
  const notes: string[] = []
  for (const step of spec.steps) {
    if (!scope.runs[step.id].length) {
      scope.runs[step.id] = [{ stepId: step.id, round: 1, state: 'waiting', calls: [], notes: [] }]
    }
    for (const run of scope.runs[step.id]) {
      notes.push(...run.notes)
    }
  }
  notes.push(...scope.notes)
  const ready = scope.calls.filter((call) => !outcomes.has(call.id))
  const plan: GraphPlan = {
    runs: scope.runs,
    calls: scope.calls,
    ready,
    ...(scope.loop ? { loop: scope.loop } : {}),
    ...(scope.find ? { find: scope.find } : {}),
    ...(scope.route ? { route: scope.route } : {}),
    notes: [...new Set(notes)],
    settled: ready.length === 0,
    ...(scope.web ? { web: graphWebSettling(scope) } : {})
  }
  if (plan.settled) {
    plan.outcome = graphSeatOutcome(scope, graphWebOutcome(scope, graphOutcome(scope)))
  }
  return plan
}
