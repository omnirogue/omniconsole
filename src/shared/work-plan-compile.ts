import { drawnWorkPlanSteps, newWorkPlanHandoffs, newWorkPlanSteps } from './work-plan-revision'
import { workPlanDefinitionContract } from './work-plan-conditions'
import { compileNextStepChain } from './next-step-compile'
import { compileNextStepOutcomes } from './next-outcome-definition-compile'
import type { NextStepDraft } from './next-step-draft'
import { workPlanDraft } from './work-plan-draft'
import { reviewRoundContractProblems } from './session-chain-review-contract'
import type { SessionChainHandoffStep } from './session-follow-up-rule'
import type { SessionOutcomeDefinition } from './session-outcome-types'
import { validateSessionOutcomeDefinitions } from './session-outcome-validation'
import type { WorkPlanRuntimeStep } from './work-plan-runtime-adapter'
import {
  WORK_PLAN_READ_ONLY_ROLES,
  workPlanNodeActors,
  workPlanNodeGroup,
  workPlanProducers,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanProblem,
  workPlanOutcomeOf
} from './work-plan-types'

export const WORK_PLAN_REPORT_EXCERPT_CHARS = 12_000
export const WORK_PLAN_EXECUTION_BRIEF_MAX_CHARS = 100_000

export type WorkPlanCompileContext = WorkPlanContext & {
  chainId?: string
  workspacePath?: string
  /** WP-4a's bounded predecessor excerpts; whole reports remain in files. */
  reportExcerptChars?: number
  sourceContextChars?: number
  /**
   * This commit ASKS the people the plan finishes at, rather than re-reading an ask already made.
   * Only then is a review of somebody who has already answered a second ask with a step of its
   * own (`newWorkPlanHandoffs`); a commit that merely carries the finish forward never re-sends it.
   */
  asksPeopleAgain?: boolean
}
const block = (code: string, message: string, nodeId?: string): WorkPlanProblem => ({
  code,
  message,
  nodeId,
  severity: 'block'
})

export function compileWorkPlan(
  plan: WorkPlan,
  ctx: WorkPlanCompileContext
): { draft: NextStepDraft; problems: WorkPlanProblem[] } {
  const { draft, problems } = compileWorkPlanExecution(plan, ctx)
  return { draft, problems }
}

/** Canonical compilers produce execution; this adapter adds the authored graph and its one contract. */
export function compileWorkPlanExecution(
  plan: WorkPlan,
  ctx: WorkPlanCompileContext
): {
  draft: NextStepDraft
  steps: WorkPlanRuntimeStep[]
  /** The people the plan finishes at, as the chain's own handoff steps. */
  handoffs: SessionChainHandoffStep[]
  /**
   * The ids of the steps the existing chain already carries that this plan STILL DRAWS: the seats
   * whose plan node it kept and did not re-compile, and the handoff whose ask it still makes. What
   * a superseding commit must NOT retire (`SessionOutcomeCommit.drawsSteps`).
   */
  drawsSteps: string[]
  outcomes: SessionOutcomeDefinition[]
  problems: WorkPlanProblem[]
} {
  const { draft, problems } = workPlanDraft(plan, ctx)
  const result = {
    draft,
    steps: [] as WorkPlanRuntimeStep[],
    handoffs: [] as SessionChainHandoffStep[],
    drawsSteps: [] as string[],
    outcomes: [] as SessionOutcomeDefinition[],
    problems
  }
  if (problems.some((p) => p.severity === 'block')) {
    return result
  }
  if (
    [ctx.reportExcerptChars, ctx.sourceContextChars].some(
      (budget) => budget !== undefined && (!Number.isFinite(budget) || budget < 0)
    )
  ) {
    problems.push(
      block('brief-budget-invalid', 'Brief budgets must be finite, nonnegative character counts.')
    )
    return result
  }
  const chainId = ctx.chainId ?? ctx.existingChain?.id ?? 'work-plan-preview'
  const workspacePath = ctx.workspacePath ?? ctx.existingChain?.workspacePath ?? '.'
  let compiled: ReturnType<typeof compileNextStepChain>
  try {
    compiled = compileNextStepChain({
      draft,
      chainId,
      workspacePath,
      sessionLabel: workPlanOutcomeOf(plan).title,
      defaultNote: workPlanOutcomeOf(plan).title,
      now: 0,
      mintStepId: (n) => `seat_${n}`,
      mintOperationId: () => 'work_plan',
      // A plan that finishes at a person stands on its own: the card is what the person
      // ticks, never a precondition for handing work over (Sal's ruling, Wave 3).
      cardlessHandoffs: true
    })
  } catch (error) {
    problems.push(
      block('work-plan-lowering', error instanceof Error ? error.message : String(error))
    )
    return result
  }
  problems.push(
    ...compiled.problems.map((p) => block(p.kind, `Cannot compile work plan: ${p.kind}`))
  )
  // A plan that finishes at a person compiles a handoff step. It is not a seat — it carries no
  // node, no readsFrom and no verdict — so it rides beside the seats rather than through their
  // wiring, and it is delivered by the same host step the ＋ builder has always used.
  const asks = compiled.steps.filter(
    (step): step is SessionChainHandoffStep => step.kind === 'handoff'
  )
  const handoffs = newWorkPlanHandoffs(asks, ctx.existingChain, ctx.asksPeopleAgain)
  let steps: WorkPlanRuntimeStep[] = compiled.steps.filter((step) => step.kind !== 'handoff')
  const oldSteps = ctx.existingChain?.steps.filter((step) => step.kind !== 'handoff') ?? []
  const version = ctx.existingChain ? (ctx.existingChain.planVersion ?? 1) + 1 : 1
  const ids = new Map<string, string[]>()
  for (const step of oldSteps) {
    if (step.planNodeId) {
      ids.set(step.planNodeId, [...(ids.get(step.planNodeId) ?? []), step.id])
    }
  }
  for (const node of plan.nodes) {
    if (node.kind === 'finish') {
      continue
    }
    const own = steps.filter(
      (step) =>
        step.editorStepId === node.id ||
        step.editorStepId === `${node.id}_repair` ||
        workPlanNodeActors(node).some((_, i) => step.editorStepId === `${node.id}_seat_${i + 1}`)
    )
    if (!own.length) {
      continue
    }
    own.forEach((step, index) => {
      step.planNodeId = node.id
      step.planVersion = version
      if (node.stage) {
        step.stage = node.stage
      }
      step.seat = { index: index + 1, total: own.length }
      step.route = node.route ?? 'new-session'
      step.writes =
        node.kind === 'worker'
          ? (node.writes ??
            ((WORK_PLAN_READ_ONLY_ROLES as readonly string[]).includes(node.role)
              ? 'own-output-dir'
              : 'workspace'))
          : 'own-output-dir'
    })
    ids.set(
      node.id,
      own.map((step) => step.id)
    )
  }
  for (const step of steps) {
    if (step.group) {
      const cohort = steps.filter((entry) => entry.group === step.group)
      step.seat = { index: cohort.indexOf(step) + 1, total: cohort.length }
    }
  }
  const expand = (names: string[]): string[] => names.flatMap((id) => ids.get(id) ?? [])
  for (const step of steps) {
    const node = plan.nodes.find((node) => node.id === step.planNodeId)!
    if (node.kind === 'finish') {
      continue
    }
    step.readsFrom = expand(
      workPlanProducers(plan, node)
        .filter((p) => !workPlanNodeGroup(node) || workPlanNodeGroup(p) !== workPlanNodeGroup(node))
        .map((p) => p.id)
    )
    if (node.kind === 'review') {
      const before = steps
        .slice(0, steps.indexOf(step))
        .filter((entry) => entry.planNodeId === node.id)
      const round = step.review?.round ?? step.reviewRepair?.afterRound ?? 1
      step.readsFrom.push(
        ...before
          .filter((entry) =>
            entry.reviewRepair
              ? entry.reviewRepair.afterRound < round
              : entry.review?.round === (step.reviewRepair ? round : round - 1)
          )
          .map((entry) => entry.id)
      )
    }
    if (!node.readsFrom) {
      step.readsFrom = [
        ...new Set([...(ctx.existingChain?.outcomeSet?.completedSteps ?? []), ...step.readsFrom])
      ]
    }
    if (node.verdict && !step.reviewRepair) {
      // The round (unanimous, version-pinned) is the gate; a per-seat gate would be refused as
      // naming a step rather than a done-when entry.
      if (node.kind === 'review' && step.review && node.verdict.consumed === 'gate') {
        step.review = { ...step.review, gate: true }
      }
      step.verdict = {
        ...node.verdict,
        ...((node.kind === 'worker' && ['review', 'critique'].includes(node.role)) ||
        step.review?.gate
          ? { consumed: 'record' as const }
          : {}),
        over:
          node.kind === 'worker' && node.role === 'verify'
            ? [...node.verdict.over]
            : expand(node.verdict.over)
      }
    }
    if (node.kind === 'worker') {
      if (node.readsWinnerOf) {
        step.readsWinnerOf = ids.get(node.readsWinnerOf)?.[0]
      }
      if (node.enabledBy) {
        step.enabledBy = {
          verdict: ids.get(node.enabledBy.verdict)![0]!,
          seatsOf: node.enabledBy.seatsOf
        }
      }
      if (node.onFail) {
        step.onFail = ids.get(node.onFail)?.[0]
      }
    }
  }
  steps = newWorkPlanSteps(steps, ctx.existingChain)
  // What this plan KEEPS of the chain it is superseding: only the lowering knows which nodes it
  // re-compiled, so it is the only place that can say (`SessionOutcomeCommit.drawsSteps`).
  const drawsSteps = drawnWorkPlanSteps({
    nodeIds: plan.nodes.filter((node) => node.kind !== 'finish').map((node) => node.id),
    remint: steps,
    asks,
    existing: ctx.existingChain
  })
  try {
    const allSteps = [...oldSteps, ...steps]
    // The handoff belongs to the outcome (it is how its work reaches people), so it is named
    // in `stepIds` and counted by the caps — but it is not a seat the wiring reads.
    const everyStep = [...allSteps, ...handoffs]
    if (new Set(allSteps.map((step) => step.id)).size !== allSteps.length) {
      throw new Error('Compiled step IDs collide. Give the new nodes shorter, distinct IDs.')
    }
    const fallback = plan.nodes.find((n) => n.kind !== 'finish')
    const toPeople = plan.nodes.some(
      (node) => node.kind === 'finish' && node.finishWith?.people.length
    )
    // A plan can be nothing but "send this to Sal": the work is what the conversation has
    // already produced. Everything else needs a stage to produce something.
    if (!fallback && !toPeople) {
      throw new Error('Add an agent stage before committing.')
    }
    const outcomes = compileNextStepOutcomes(
      draft.outcomes!.map((outcome) => ({ ...outcome, instructions: '' })),
      {
        chainId,
        workspacePath,
        sessionLabel: workPlanOutcomeOf(plan).title,
        // Unused on the people path (a person finish writes no finish action); present
        // because the compiler asks for an actor before it knows which finish it has.
        fallbackActor: fallback?.actor ?? { agent: ctx.usableAgents[0]?.agent ?? 'claude' },
        steps: everyStep
      }
    )
    const definition = outcomes[0]!
    definition.instructions = workPlanOutcomeOf(plan).title
    definition.title = workPlanOutcomeOf(plan).title
    definition.outputKind = workPlanOutcomeOf(plan).outputKind
    definition.actions = []
    const contract = workPlanDefinitionContract(plan, allSteps, definition, ctx.existingChain)
    definition.conditions = contract.conditions
    definition.finish = contract.finish
    for (const step of steps) {
      problems.push(
        ...reviewRoundContractProblems({ steps }, step).map((p) =>
          block(p.code, p.message, step.planNodeId)
        )
      )
      // Executor adds source, definition JSON, predecessor reports and authority instructions.
      const estimate =
        step.prompt.length +
        JSON.stringify(outcomes).length +
        (ctx.sourceContextChars ??
          JSON.stringify(ctx.existingChain?.outcomeSet?.continuation.sourcePacket ?? '').length) +
        ((step.readsFrom?.length ?? 0) + (step.readsWinnerOf ? 1 : 0)) *
          (ctx.reportExcerptChars ?? WORK_PLAN_REPORT_EXCERPT_CHARS) +
        4096
      if (estimate > WORK_PLAN_EXECUTION_BRIEF_MAX_CHARS) {
        problems.push(
          block(
            'brief-over-cap',
            `${step.planNodeId} needs an estimated ${estimate} characters; the executor limit is 100,000. Reduce its inputs or excerpt budget.`,
            step.planNodeId
          )
        )
      }
    }
    validateSessionOutcomeDefinitions(
      ctx.existingChain
        ? outcomes.map((o) => ({
            ...o,
            stepIds: steps.map((s) => s.id),
            instructions: steps.length ? o.instructions : undefined
          }))
        : outcomes,
      { steps: ctx.existingChain ? [...steps, ...handoffs] : everyStep }
    )
    result.outcomes = outcomes
    result.steps = steps
    result.handoffs = handoffs
    result.drawsSteps = drawsSteps
  } catch (error) {
    problems.push(
      block('work-plan-lowering', error instanceof Error ? error.message : String(error))
    )
  }
  return result
}
