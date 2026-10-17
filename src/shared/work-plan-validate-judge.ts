import {
  isIndependentLineage,
  mayIssueVerdict,
  modelLineage,
  type ModelLineage
} from './model-lineage'
import { isSessionVerdictPresetId } from './session-action-presets'
import {
  WORK_PLAN_ROLE_PRESET,
  workPlanNodeActors,
  workPlanProducers,
  type WorkPlan,
  type WorkPlanActor,
  type WorkPlanContext,
  type WorkPlanNode,
  type WorkPlanProblem
} from './work-plan-types'

/** Who is allowed to decide: never Gemini, and never a judge from a candidate's own family. */
function block(code: string, nodeId: string, message: string): WorkPlanProblem {
  return { code, nodeId, message, severity: 'block' }
}

function actorName(actor: WorkPlanActor): string {
  return actor.model ? `${actor.agent} ${actor.model}` : actor.agent
}

/** Candidates a verdict ranges over: what its step was given to read, minus the other verdicts. */
function candidatesOf(plan: WorkPlan, node: WorkPlanNode): WorkPlanNode[] {
  const verdict = node.kind === 'finish' ? undefined : node.verdict
  const ids = new Set([
    ...(verdict?.over ?? []),
    ...workPlanProducers(plan, node).map((entry) => entry.id)
  ])
  return plan.nodes.filter(
    (entry) => ids.has(entry.id) && entry.kind !== 'finish' && !entry.verdict
  )
}

function isJudge(node: WorkPlanNode): boolean {
  if (node.kind === 'finish') {
    return false
  }
  return node.verdict?.kind === 'judge' || (node.kind === 'worker' && node.role === 'judge')
}

/** The same set the estate's review policy keys on, so a plan and its compiled chain agree. */
function decides(node: WorkPlanNode): boolean {
  if (node.kind === 'finish') {
    return false
  }
  if (node.kind === 'review' || node.verdict) {
    return true
  }
  return isSessionVerdictPresetId(WORK_PLAN_ROLE_PRESET[node.role])
}

function familiesOf(plan: WorkPlan, node: WorkPlanNode): ModelLineage[] {
  return [
    ...new Set(
      candidatesOf(plan, node).flatMap((entry) =>
        workPlanNodeActors(entry).map((actor) => modelLineage(actor.agent, actor.model))
      )
    )
  ]
}

/** A seat may judge when it decides at all and its family is none of the candidates'. */
function independentOf(families: readonly ModelLineage[], seat: WorkPlanActor): boolean {
  return (
    mayIssueVerdict(seat.agent, seat.model) &&
    families.every((family) => isIndependentLineage(family, modelLineage(seat.agent, seat.model)))
  )
}

export function workPlanJudgeProblems(
  plan: WorkPlan,
  node: WorkPlanNode,
  ctx: WorkPlanContext
): WorkPlanProblem[] {
  if (!decides(node)) {
    return []
  }
  const problems: WorkPlanProblem[] = []
  for (const actor of workPlanNodeActors(node)) {
    if (mayIssueVerdict(actor.agent, actor.model)) {
      continue
    }
    problems.push(
      block(
        'verdict-actor-refused',
        node.id,
        modelLineage(actor.agent, actor.model) === 'google'
          ? `${actorName(actor)} never issues a review verdict. Choose Claude, Codex or Grok to decide.`
          : `This build cannot tell which model family ${actorName(actor)} draws on, so it cannot be shown to be independent of what it judges. Choose Claude, Codex or Grok to decide.`
      )
    )
  }
  const families = isJudge(node) ? familiesOf(plan, node) : []
  if (families.length === 0) {
    return problems
  }
  const collision = workPlanNodeActors(node).find((actor) => !independentOf(families, actor))
  if (!collision) {
    return problems
  }
  const available = ctx.usableAgents.some((candidate) =>
    candidate.models.length > 0
      ? candidate.models.some((model) =>
          independentOf(families, { agent: candidate.agent, model: model.id })
        )
      : independentOf(families, { agent: candidate.agent })
  )
  problems.push(
    available || ctx.usableAgents.length === 0
      ? block(
          'judge-family-collision',
          node.id,
          `${actorName(collision)} judges candidates from its own model family. A judge comes from a family none of the candidates belong to.`
        )
      : block(
          'judge-family-unavailable',
          node.id,
          `Best-of-N needs a judge from a different model family; you have ${ctx.usableAgents.length} usable agents`
        )
  )
  return problems
}
