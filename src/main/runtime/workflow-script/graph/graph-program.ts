import type { WorkflowProgramContext } from '../workflow-program-context'
import { WorkflowCallLaunchError } from '../workflow-launch-failure'
import {
  planWorkflowGraph,
  type GraphCall,
  type GraphConfig,
  type GraphDegraded,
  type GraphOutcome,
  type GraphTask
} from './graph-plan'

export type GraphProgramResult = {
  final: { stepId: string; markdown: string }
  gaps: string[]
  /** Calls lost that no other seat could take (graph-seat-substitution.ts). */
  degraded?: GraphDegraded
}

/**
 * One call through the durable port. A call that fails after every attempt the run allows
 * settles as failed; a fatal error (stop, pause, unverifiable attempt) rejects and ends the run.
 */
async function settle(
  context: WorkflowProgramContext,
  config: GraphConfig,
  call: GraphCall
): Promise<GraphOutcome> {
  if (call.jev) {
    if (config.spec.finalCheck?.rank === call.stepId && call.round === 2) {
      const [outcome] = await context.parallel([() => config.judgeWithJev?.(call)])
      if (outcome) {
        return outcome as GraphOutcome
      }
      // No outcome: classify the same way a refused agent call is classified below, so a call
      // Finish now cancelled mid-flight settles as skipped (finished-early), never a bare failure.
      return config.refused?.(call.id) ? { failed: true, skipped: true } : { failed: true }
    }
    // Never an agent: without a judge (or when it cannot answer) the model judges stand in.
    return config.judgeWithJev ? config.judgeWithJev(call) : { failed: true }
  }
  if (call.screen) {
    // Never an agent: JEV scores the whole pool of options.
    return config.screenWithJev ? config.screenWithJev(call) : { failed: true }
  }
  if (call.verify) {
    // Never an agent: JEV's shadow yes/no per item, recorded and read by nothing the run decides.
    return config.verifyWithJev ? config.verifyWithJev(call) : { failed: true }
  }
  if (call.route) {
    // Never an agent: JEV reads whether the question has one right answer.
    return config.routeWithJev ? config.routeWithJev(call) : { failed: true }
  }
  if (call.facts) {
    // Never an agent: the host asks GitHub about the repositories the options name.
    return config.fetchFacts ? config.fetchFacts(call) : { failed: true }
  }
  if (call.harvest) {
    // Never an agent: the host runs the person's GitHub search and keeps what it found.
    return config.harvestGitHub ? config.harvestGitHub(call) : { failed: true }
  }
  if (call.evidence) {
    // Never an agent: the app reads the quoted files in the workspace.
    return config.checkEvidence ? config.checkEvidence(call) : { failed: true }
  }
  if (call.web) {
    // Never an agent: the app reads the pages, and seats only ever see the kept text.
    return config.readWeb ? config.readWeb(call) : { failed: true }
  }
  if (call.check) {
    // Never an agent: the host runs the person's command on the version, admitted like one.
    context.guard()
    return config.checkCandidate ? config.checkCandidate(call) : { failed: true }
  }
  const step = config.spec.steps.find((entry) => entry.id === call.stepId)
  const singleDiscover =
    (config.seatRules ?? 0) >= 2 &&
    config.spec.template === 'discover' &&
    (step?.id === 'brief' || step?.id === 'scout') &&
    step.agents.length === 1
  let failure: string | undefined
  const [value] = await context.parallel([
    () =>
      context.agent(call).catch((error: unknown) => {
        if (error instanceof WorkflowCallLaunchError || singleDiscover) {
          failure = error instanceof Error ? error.message : String(error)
        }
        throw error
      })
  ])
  if (value !== null && value !== undefined) {
    return { value }
  }
  if (config.refused?.(call.id)) {
    return { failed: true, skipped: true }
  }
  // Seat rules: once, on another seat; the substitute itself is never moved again.
  const substitute = await config.substitute?.(call, failure, singleDiscover)
  if (!substitute) {
    return failure && config.seatRules !== undefined
      ? { failed: true, lost: failure }
      : { failed: true }
  }
  const [again] = await context.parallel([
    () => context.agent({ ...call, id: substitute.callId, seatId: substitute.seatId })
  ])
  return again !== null && again !== undefined
    ? { value: again, substitute }
    : { failed: true, lost: failure ?? substitute.reason, substitute }
}

/**
 * The workflow graph interpreter: plan, launch every ready call, wait for one to settle, plan
 * again. Independent steps and a step's agents run at once (the durable port's slots bound how
 * many processes run together); a step starts the moment its inputs have settled. The run
 * finishes when nothing is ready and nothing is running, and succeeds only when the final step
 * produced a result (graph-plan.ts `graphOutcome`).
 */
export async function runWorkflowGraphProgram(
  context: WorkflowProgramContext,
  config: GraphConfig,
  task: GraphTask
): Promise<GraphProgramResult> {
  const outcomes = new Map<string, GraphOutcome>()
  const inflight = new Map<string, Promise<void>>()
  const logged = new Set<string>()
  const announced = new Set<string>()
  const titles = new Map(config.spec.steps.map((step) => [step.id, step.title]))
  let fatal: { error: unknown } | undefined
  for (;;) {
    const plan = planWorkflowGraph(config, task, outcomes)
    for (const note of plan.notes) {
      if (!logged.has(note)) {
        logged.add(note)
        context.log(note)
      }
    }
    if (!fatal) {
      for (const call of plan.ready) {
        if (inflight.has(call.id)) {
          continue
        }
        const stage = `${call.stepId}:${call.round}`
        if (!announced.has(stage)) {
          announced.add(stage)
          const title = titles.get(call.stepId) ?? call.stepId
          context.phase(plan.loop && call.round > 1 ? `${title} (round ${call.round})` : title)
        }
        const running = settle(context, config, call)
          .then(
            (outcome) => {
              outcomes.set(call.id, outcome)
            },
            (error: unknown) => {
              fatal ??= { error }
            }
          )
          .finally(() => inflight.delete(call.id))
        inflight.set(call.id, running)
      }
    }
    if (!inflight.size) {
      if (fatal) {
        throw fatal.error
      }
      const outcome = plan.outcome
      if (!plan.settled || !outcome) {
        throw new Error('The workflow stopped with calls it could not start.')
      }
      try {
        config.onSettled?.(plan, outcomes)
      } catch (error) {
        // Why: the record is evidence for later learning; it must never fail the run itself.
        context.log(
          `Could not write the judging record: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (outcome.state === 'failed') {
        throw new Error(outcome.error ?? 'The workflow failed.')
      }
      return {
        final: outcome.final!,
        gaps: outcome.gaps,
        ...(outcome.degraded ? { degraded: outcome.degraded } : {})
      }
    }
    await Promise.race(inflight.values())
  }
}
