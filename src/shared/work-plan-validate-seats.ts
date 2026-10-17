import { NEXT_STEP_MAX_REVIEWERS } from './next-step-draft'
import {
  WORK_PLAN_MAX_REVIEW_ROUNDS,
  WORK_PLAN_READ_ONLY_ROLES,
  WORK_PLAN_REVIEW_KINDS,
  WORK_PLAN_REVIEW_STOP_RULES,
  workPlanNodeActors,
  workPlanOutcomeOf,
  workPlanParallelSeats,
  type WorkPlan,
  type WorkPlanActor,
  type WorkPlanContext,
  type WorkPlanNode,
  type WorkPlanProblem
} from './work-plan-types'
import { workPlanJudgeProblems } from './work-plan-validate-judge'
import { workPlanRouteProblems } from './work-plan-validate-route'

/** What each seat is allowed to be: its route, its width, what it writes, and who runs it. */
function block(code: string, nodeId: string, message: string): WorkPlanProblem {
  return { code, nodeId, message, severity: 'block' }
}

function actorName(actor: WorkPlanActor): string {
  return actor.model ? `${actor.agent} ${actor.model}` : actor.agent
}

function writeProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  if (node.kind !== 'worker' || workPlanParallelSeats(plan, node) < 2) {
    return []
  }
  if (node.writes === 'workspace') {
    return [
      block(
        'parallel-writes-workspace',
        node.id,
        `${node.id} writes the workspace while other seats run beside it. Per-seat worktrees do not exist yet; give each seat its own output folder, or run them one after another.`
      )
    ]
  }
  const reads = (WORK_PLAN_READ_ONLY_ROLES as readonly string[]).includes(node.role)
  return reads || node.writes === 'own-output-dir'
    ? []
    : [
        block(
          'parallel-writes-undeclared',
          node.id,
          `${node.id} runs beside other seats as a ${node.role} step without saying where it writes. Give each seat its own output folder.`
        )
      ]
}

function outputKindProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  if (workPlanOutcomeOf(plan).outputKind === 'work') {
    return []
  }
  if (node.kind === 'finish') {
    return node.how === 'complete'
      ? []
      : [
          block(
            'output-kind-finish-gate',
            node.id,
            'A plan finishes when its plan file is there; it needs no Go from you.'
          )
        ]
  }
  const problems: WorkPlanProblem[] = []
  if (
    node.kind === 'worker' &&
    !(WORK_PLAN_READ_ONLY_ROLES as readonly string[]).includes(node.role)
  ) {
    problems.push(
      block(
        'output-kind-role',
        node.id,
        `${node.id} is a ${node.role} step in a plan-only run. Planning steps read and write their plan, they do not build.`
      )
    )
  }
  if (node.kind === 'worker' && node.writes === 'workspace') {
    problems.push(
      block(
        'output-kind-writes-workspace',
        node.id,
        `${node.id} would change the workspace in a plan-only run.`
      )
    )
  }
  return problems
}

function shapeProblems(node: WorkPlanNode): WorkPlanProblem[] {
  const problems: WorkPlanProblem[] = []
  if (
    node.kind === 'worker' &&
    node.count !== undefined &&
    (!Number.isInteger(node.count) || node.count < 1)
  ) {
    problems.push(
      block('count-invalid', node.id, `${node.id} needs a whole number of seats, at least one.`)
    )
  }
  if (
    node.kind === 'worker' &&
    node.seats &&
    node.seats.length !== Math.max(1, Math.trunc(node.count ?? 1))
  ) {
    problems.push(
      block(
        'seats-count-mismatch',
        node.id,
        `${node.id} names ${node.seats.length} seats for ${node.count ?? 1}. Name one agent per seat.`
      )
    )
  }
  if (node.kind !== 'review') {
    return problems
  }
  if (
    !Number.isInteger(node.maxRounds) ||
    node.maxRounds < 1 ||
    node.maxRounds > WORK_PLAN_MAX_REVIEW_ROUNDS
  ) {
    problems.push(
      block(
        'review-rounds-out-of-range',
        node.id,
        `Choose between one and ${WORK_PLAN_MAX_REVIEW_ROUNDS} review rounds.`
      )
    )
  }
  if (!(WORK_PLAN_REVIEW_KINDS as readonly string[]).includes(node.loop)) {
    problems.push(
      block(
        'review-kind-unknown',
        node.id,
        `${node.id} runs a kind of loop this build does not know. Choose ${WORK_PLAN_REVIEW_KINDS.join(', ')}.`
      )
    )
  }
  if (!(WORK_PLAN_REVIEW_STOP_RULES as readonly string[]).includes(node.stop)) {
    problems.push(
      block(
        'review-stop-unknown',
        node.id,
        `${node.id} stops on a rule this build does not know. Choose ${WORK_PLAN_REVIEW_STOP_RULES.join(', ')}.`
      )
    )
  }
  if ((node.seats?.length ?? 1) > NEXT_STEP_MAX_REVIEWERS) {
    problems.push(
      block(
        'review-too-many-reviewers',
        node.id,
        `Choose up to ${NEXT_STEP_MAX_REVIEWERS} reviewers.`
      )
    )
  }
  if (node.readsFrom.length === 0) {
    problems.push(
      block(
        'review-reads-nothing',
        node.id,
        `${node.id} reviews nothing. Name the step whose result it reviews.`
      )
    )
  }
  return problems
}

function usable(ctx: WorkPlanContext, actor: WorkPlanActor): boolean {
  if (ctx.usableAgents.length === 0) {
    return true
  }
  const agent = ctx.usableAgents.find((candidate) => candidate.agent === actor.agent)
  if (!agent) {
    return false
  }
  if (!actor.model) {
    return true
  }
  const model = agent.models.find((candidate) => candidate.id === actor.model)
  return Boolean(model) && (!actor.effort || model!.efforts.includes(actor.effort))
}

function actorProblems(node: WorkPlanNode, ctx: WorkPlanContext): WorkPlanProblem[] {
  const actors = workPlanNodeActors(node)
  const problems: WorkPlanProblem[] = []
  for (const actor of actors) {
    if (!usable(ctx, actor)) {
      problems.push(
        block(
          'actor-not-usable',
          node.id,
          `${actorName(actor)} is not usable on this host. Choose an agent this host can launch.`
        )
      )
    }
  }
  const seen = new Set<string>()
  const duplicate = actors.find((actor) => {
    const key = `${actor.agent}:${actor.model ?? ''}`
    if (seen.has(key)) {
      return true
    }
    seen.add(key)
    return false
  })
  if (duplicate && actors.length > 1) {
    problems.push({
      code: 'actor-duplicate-seat',
      nodeId: node.id,
      message: `${node.id} runs ${actorName(duplicate)} on more than one seat, so those seats are not a second opinion.`,
      severity: 'warn'
    })
  }
  return problems
}

export function workPlanSeatProblems(plan: WorkPlan, ctx: WorkPlanContext): WorkPlanProblem[] {
  return plan.nodes.flatMap((node) => [
    ...workPlanRouteProblems(plan, node, ctx),
    ...writeProblems(plan, node),
    ...outputKindProblems(plan, node),
    ...shapeProblems(node),
    ...(node.kind === 'finish' ? [] : actorProblems(node, ctx)),
    ...workPlanJudgeProblems(plan, node, ctx)
  ])
}
