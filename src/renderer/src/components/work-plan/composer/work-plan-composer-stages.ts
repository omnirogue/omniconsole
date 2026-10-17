import { compileWorkPlanExecution } from '../../../../../shared/work-plan-compile'
import {
  workPlanNodeGroup,
  workPlanNodeSeatCount,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanFinishNode,
  type WorkPlanNode,
  type WorkPlanProblem,
  type WorkPlanReviewNode,
  type WorkPlanWorkerNode
} from '../../../../../shared/work-plan-types'

/** Everything the dialog can edit; the finish is shown, not edited as a stage. */
export type ComposerStageNode = WorkPlanWorkerNode | WorkPlanReviewNode

/**
 * One row of the dialog. A ×N node is one stage, and so is a group of sibling nodes that run
 * side by side (a Council's answers), because that is exactly what the notation folds into one
 * `⑂N` glyph: the list the person reads and the chain they read above it cannot drift apart.
 */
export type ComposerStage = {
  key: string
  index: number
  nodes: ComposerStageNode[]
  seats: number
}

export function isComposerStageNode(node: WorkPlanNode): node is ComposerStageNode {
  return node.kind !== 'finish'
}

export function composerStages(plan: WorkPlan): ComposerStage[] {
  const stages: ComposerStage[] = []
  for (const node of plan.nodes) {
    if (!isComposerStageNode(node)) {
      continue
    }
    const group = node.kind === 'worker' ? node.group : undefined
    const previous = stages.at(-1)
    const sharesGroup =
      Boolean(group) &&
      previous !== undefined &&
      previous.nodes.some((entry) => workPlanNodeGroup(entry) === group)
    if (sharesGroup && previous) {
      previous.nodes.push(node)
      previous.seats += workPlanNodeSeatCount(node)
      continue
    }
    stages.push({
      key: node.id,
      index: stages.length + 1,
      nodes: [node],
      seats: workPlanNodeSeatCount(node)
    })
  }
  return stages
}

export function composerFinish(plan: WorkPlan): WorkPlanFinishNode | undefined {
  return plan.nodes.find((node): node is WorkPlanFinishNode => node.kind === 'finish')
}

/**
 * The commit path's OWN answer, not a second opinion: `compileWorkPlanExecution` runs
 * `workPlanProblems` and then tries the lowering, so a plan the dialog calls usable is a plan
 * `commitWorkPlan` can lower. Asking only the validator would let the dialog hand the bar a
 * chain the console refuses at Send — the person would read the refusal after choosing to run it.
 */
export function workPlanComposerProblems(plan: WorkPlan, ctx: WorkPlanContext): WorkPlanProblem[] {
  return compileWorkPlanExecution(plan, ctx).problems
}

export function composerBlocks(problems: readonly WorkPlanProblem[]): WorkPlanProblem[] {
  return problems.filter((problem) => problem.severity === 'block')
}

export function stageProblems(
  problems: readonly WorkPlanProblem[],
  stage: ComposerStage
): WorkPlanProblem[] {
  const ids = new Set(stage.nodes.map((node) => node.id))
  return problems.filter((problem) => problem.nodeId !== undefined && ids.has(problem.nodeId))
}

/** Problems the person still has to see, but that no stage row owns (the plan as a whole). */
export function planWideProblems(
  plan: WorkPlan,
  problems: readonly WorkPlanProblem[]
): WorkPlanProblem[] {
  const ids = new Set(plan.nodes.map((node) => node.id))
  return problems.filter((problem) => problem.nodeId === undefined || !ids.has(problem.nodeId))
}

/** Earlier nodes whose verdict picks a winner: the only ones a later stage may improve upon. */
export function winnerSources(plan: WorkPlan, stage: ComposerStage): ComposerStageNode[] {
  const first = plan.nodes.findIndex((node) => node.id === stage.key)
  return plan.nodes
    .slice(0, Math.max(0, first))
    .filter(
      (node): node is ComposerStageNode =>
        isComposerStageNode(node) && node.verdict?.consumed === 'select-winner'
    )
}
