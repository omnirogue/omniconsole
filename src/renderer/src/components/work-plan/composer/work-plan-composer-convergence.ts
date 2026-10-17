import { judgeActor } from './work-plan-composer-actors'
import {
  insertAfterStage,
  mintNodeId,
  normalizeComposerPlan,
  rewireReferences,
  stageIds,
  withNodes,
  writesFor
} from './work-plan-composer-graph'
import {
  composerStages,
  isComposerStageNode,
  type ComposerStage,
  type ComposerStageNode
} from './work-plan-composer-stages'
import {
  workPlanNodeActors,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanNode,
  type WorkPlanWorkerNode
} from '../../../../../shared/work-plan-types'

/** Many results, one result: the two ways a fan-out comes back together, plus how it is spent. */
function stageAfter(plan: WorkPlan, ids: readonly string[]): ComposerStageNode[] {
  const last = Math.max(...ids.map((id) => plan.nodes.findIndex((node) => node.id === id)))
  return plan.nodes
    .slice(last + 1)
    .filter((node): node is ComposerStageNode => isComposerStageNode(node))
}

/** The critiques of a stage: the seats that read the OTHER candidates and record what they saw. */
export function critiquesOf(plan: WorkPlan, stage: ComposerStage): ComposerStageNode[] {
  const ids = stageIds(stage)
  return stageAfter(plan, ids).filter(
    (node) =>
      node.kind === 'worker' &&
      node.role === 'critique' &&
      (node.readsFrom ?? []).length > 0 &&
      (node.readsFrom ?? []).every((id) => ids.includes(id))
  )
}

export function synthesisOf(plan: WorkPlan, stage: ComposerStage): ComposerStageNode | undefined {
  const ids = stageIds(stage)
  return stageAfter(plan, ids).find(
    (node) =>
      node.kind === 'worker' &&
      node.role === 'synthesize' &&
      (node.readsFrom ?? []).some((id) => ids.includes(id))
  )
}

export function judgeOf(plan: WorkPlan, stage: ComposerStage): ComposerStageNode | undefined {
  const ids = stageIds(stage)
  return stageAfter(plan, ids).find(
    (node) =>
      node.verdict?.consumed === 'select-winner' && node.verdict.over.some((id) => ids.includes(id))
  )
}

export function addSynthesize(
  plan: WorkPlan,
  stage: ComposerStage,
  ctx: WorkPlanContext
): WorkPlan {
  const node: WorkPlanWorkerNode = {
    kind: 'worker',
    id: mintNodeId(plan, 'synthesis'),
    role: 'synthesize',
    instruction: '',
    actor: stage.nodes[0]?.actor ?? { agent: 'claude' },
    readsFrom: stageIds(stage)
  }
  return normalizeComposerPlan(insertAfterStage(plan, stage, [node]), ctx)
}

/**
 * ⚖ ranks exactly the candidates of this stage and reads their critiques as well, because a
 * judge that has not read the objections is ranking less information than the plan produced.
 * The actor comes from a family none of the candidates belong to.
 */
export function addJudge(plan: WorkPlan, stage: ComposerStage, ctx: WorkPlanContext): WorkPlan {
  const candidateIds = stageIds(stage)
  const critiques = critiquesOf(plan, stage)
  const critiqueIds = critiques.map((node) => node.id)
  const candidates = stage.nodes.flatMap((node) => workPlanNodeActors(node))
  const node: WorkPlanWorkerNode = {
    kind: 'worker',
    id: mintNodeId(plan, 'judge'),
    role: 'judge',
    instruction: '',
    actor: judgeActor(ctx, candidates, stage.nodes[0]?.actor ?? { agent: 'claude' }),
    readsFrom: [...candidateIds, ...critiqueIds],
    verdict: { kind: 'judge', over: candidateIds, consumed: 'select-winner' }
  }
  const anchor = critiqueIds.length
    ? composerStages(plan).find((entry) => entry.nodes.some((n) => n.id === critiqueIds.at(-1)))
    : stage
  return normalizeComposerPlan(insertAfterStage(plan, anchor ?? stage, [node]), ctx)
}

/**
 * ×N seats become N addressable nodes of one group. A Council's critiques each read the OTHER
 * answers, which no single ×N node can express: its seats have no names for one another.
 */
function expandSeats(
  plan: WorkPlan,
  stage: ComposerStage,
  ctx: WorkPlanContext
): { plan: WorkPlan; ids: string[] } {
  const node = stage.nodes[0]
  if (!node || stage.nodes.length !== 1 || node.kind !== 'worker') {
    return { plan, ids: stageIds(stage) }
  }
  const actors = workPlanNodeActors(node)
  if (actors.length < 2) {
    return { plan, ids: stageIds(stage) }
  }
  const group = `${node.id}-group`
  let taken = plan
  const siblings = actors.map((actor, seat) => {
    const id = mintNodeId(taken, `${node.id}-${seat + 1}`)
    const sibling: WorkPlanWorkerNode = {
      ...node,
      id,
      actor,
      group,
      ...(writesFor(node.role, actors.length)
        ? { writes: writesFor(node.role, actors.length)! }
        : {})
    }
    delete sibling.count
    delete sibling.seats
    taken = withNodes(taken, [...taken.nodes, sibling])
    return sibling
  })
  const at = plan.nodes.findIndex((entry) => entry.id === node.id)
  const nodes: WorkPlanNode[] = [
    ...plan.nodes.slice(0, at),
    ...siblings,
    ...plan.nodes.slice(at + 1)
  ]
  const ids = siblings.map((sibling) => sibling.id)
  return {
    plan: normalizeComposerPlan(withNodes(plan, rewireReferences(nodes, node.id, ids)), ctx),
    ids
  }
}

/** Council: every candidate reads the others and records what it found; no round is involved. */
export function addCritiques(plan: WorkPlan, stage: ComposerStage, ctx: WorkPlanContext): WorkPlan {
  const expanded = expandSeats(plan, stage, ctx)
  const stages = composerStages(expanded.plan)
  const target = stages.find((entry) => entry.nodes.some((node) => expanded.ids.includes(node.id)))
  if (!target || expanded.ids.length < 2) {
    return plan
  }
  const group = `${target.key}-critiques`
  let taken = expanded.plan
  const critiques = expanded.ids.map((id, seat) => {
    const others = expanded.ids.filter((entry) => entry !== id)
    const critique: WorkPlanWorkerNode = {
      kind: 'worker',
      id: mintNodeId(taken, `critique-${seat + 1}`),
      role: 'critique',
      instruction: '',
      actor: target.nodes[seat]?.actor ?? target.nodes[0]!.actor,
      group,
      readsFrom: others,
      verdict: { kind: 'critique', over: others, consumed: 'record' }
    }
    taken = withNodes(taken, [...taken.nodes, critique])
    return critique
  })
  return normalizeComposerPlan(insertAfterStage(expanded.plan, target, critiques), ctx)
}

/** Only the winner is improved: the stage reads the verdict and runs on what it picked. */
export function setReadsWinnerOf(
  plan: WorkPlan,
  stage: ComposerStage,
  judgeId: string | null,
  ctx: WorkPlanContext
): WorkPlan {
  const ids = new Set(stageIds(stage))
  const nodes = plan.nodes.map((node) => {
    if (!isComposerStageNode(node) || !ids.has(node.id) || node.kind !== 'worker') {
      return node
    }
    const next = { ...node }
    if (judgeId === null) {
      delete next.readsWinnerOf
      return next
    }
    return { ...next, readsWinnerOf: judgeId, readsFrom: [judgeId] }
  })
  return normalizeComposerPlan(withNodes(plan, nodes), ctx)
}

/**
 * A verify stage ranges over Done When entries, in the Outcome's own order, so what the person
 * ticked and what the host will mint receipts for are read in the same sequence.
 */
export function toggleVerifyDoneWhen(plan: WorkPlan, nodeId: string, doneWhenId: string): WorkPlan {
  const order = plan.outcome.doneWhen.map((entry) => entry.id)
  return withNodes(
    plan,
    plan.nodes.map((node) => {
      if (node.id !== nodeId || !isComposerStageNode(node) || !node.verdict) {
        return node
      }
      const over = node.verdict.over.includes(doneWhenId)
        ? node.verdict.over.filter((id) => id !== doneWhenId)
        : [...node.verdict.over, doneWhenId]
      return {
        ...node,
        verdict: {
          ...node.verdict,
          over: order.filter((id) => over.includes(id))
        }
      }
    })
  )
}
