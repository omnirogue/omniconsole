import { assignSeats, composerActors } from './work-plan-composer-actors'
import {
  insertAfterStage,
  mintNodeId,
  normalizeComposerPlan,
  renormalizeEdges,
  rewireReferences,
  stageIds,
  unique,
  withNodes,
  writesFor
} from './work-plan-composer-graph'
import {
  composerStages,
  isComposerStageNode,
  type ComposerStage,
  type ComposerStageNode
} from './work-plan-composer-stages'
import { mayIssueVerdict } from '../../../../../shared/model-lineage'
import type {
  WorkPlan,
  WorkPlanActor,
  WorkPlanContext,
  WorkPlanFinishNode,
  WorkPlanNode,
  WorkPlanReviewNode,
  WorkPlanReviewStop,
  WorkPlanRole,
  WorkPlanWorkerNode
} from '../../../../../shared/work-plan-types'

function firstActor(ctx: WorkPlanContext, fallback: WorkPlanActor): WorkPlanActor {
  return composerActors(ctx)[0] ?? fallback
}

export function addStageAfter(
  plan: WorkPlan,
  stage: ComposerStage | undefined,
  ctx: WorkPlanContext
): WorkPlan {
  const role: WorkPlanRole = plan.outcome.outputKind === 'work' ? 'implement' : 'plan'
  const stages = composerStages(plan)
  const previous = stage ?? stages.at(-1)
  const fallback = previous?.nodes[0]?.actor ?? { agent: 'claude' as const }
  const node: WorkPlanWorkerNode = {
    kind: 'worker',
    id: mintNodeId(plan, role),
    role,
    instruction: '',
    actor: firstActor(ctx, fallback),
    ...(previous ? { readsFrom: stageIds(previous) } : {}),
    ...(writesFor(role, 1) ? { writes: writesFor(role, 1)! } : {})
  }
  return normalizeComposerPlan(insertAfterStage(plan, previous, [node]), ctx)
}

/** A removed stage hands its own readers on, so the chain closes up instead of breaking. */
export function removeStage(plan: WorkPlan, stage: ComposerStage, ctx: WorkPlanContext): WorkPlan {
  const ids = stageIds(stage)
  const inherited = unique(stage.nodes.flatMap((node) => node.readsFrom ?? []))
  let nodes: WorkPlanNode[] = plan.nodes.filter((node) => !ids.includes(node.id))
  for (const id of ids) {
    nodes = rewireReferences(nodes, id, inherited)
  }
  return normalizeComposerPlan(withNodes(plan, nodes), ctx)
}

export function moveStage(
  plan: WorkPlan,
  stage: ComposerStage,
  direction: -1 | 1,
  ctx: WorkPlanContext
): WorkPlan {
  const stages = composerStages(plan)
  const at = stages.findIndex((entry) => entry.key === stage.key)
  const target = at + direction
  if (at === -1 || target < 0 || target >= stages.length) {
    return plan
  }
  const blocks = stages.map((entry) => entry.nodes as WorkPlanNode[])
  blocks[at] = stages[target]!.nodes
  blocks[target] = stages[at]!.nodes
  const finish = plan.nodes.filter((node) => !isComposerStageNode(node))
  return normalizeComposerPlan(
    renormalizeEdges(withNodes(plan, [...blocks.flat(), ...finish])),
    ctx
  )
}

export function duplicateStage(
  plan: WorkPlan,
  stage: ComposerStage,
  ctx: WorkPlanContext
): WorkPlan {
  let taken = plan
  const copies = stage.nodes.map((node) => {
    const id = mintNodeId(taken, node.id)
    taken = withNodes(taken, [...taken.nodes, { ...node, id }])
    return { ...node, id } as ComposerStageNode
  })
  return normalizeComposerPlan(insertAfterStage(plan, stage, copies), ctx)
}

function reviewNodeFrom(node: ComposerStageNode, fallbackReads: string[]): WorkPlanReviewNode {
  const reads = node.readsFrom?.length ? node.readsFrom : fallbackReads
  return {
    kind: 'review',
    id: node.id,
    actor: node.actor,
    seats: node.seats?.length ? node.seats : [node.actor],
    readsFrom: reads,
    loop: 'review',
    maxRounds: 1,
    stop: 'zero_blockers',
    verdict: { kind: 'review', over: reads, consumed: 'gate' },
    ...(node.instruction ? { instruction: node.instruction } : {})
  }
}

function workerNodeFrom(node: ComposerStageNode, role: WorkPlanRole): WorkPlanWorkerNode {
  const { verdict, ...rest } = node as WorkPlanWorkerNode
  return {
    ...rest,
    kind: 'worker',
    role,
    instruction: node.instruction ?? '',
    ...(role === 'verify'
      ? { verdict: { kind: 'verify' as const, over: [], consumed: 'gate' as const } }
      : verdict && verdict.kind !== 'verify' && verdict.kind !== 'review'
        ? { verdict }
        : {})
  }
}

/**
 * ACTION is the one knob that changes what a stage IS: `review` is the engine's review round
 * (rounds + a stop rule over one candidate), `verify` measures the work against the Outcome and
 * therefore carries a gate over Done When entries, and every other role is plain work.
 */
export function setStageRole(
  plan: WorkPlan,
  stage: ComposerStage,
  role: WorkPlanRole,
  ctx: WorkPlanContext
): WorkPlan {
  const stages = composerStages(plan)
  const at = stages.findIndex((entry) => entry.key === stage.key)
  const fallbackReads = at > 0 ? stageIds(stages[at - 1]!) : []
  const ids = new Set(stageIds(stage))
  let nodes = plan.nodes.map((node) =>
    isComposerStageNode(node) && ids.has(node.id)
      ? role === 'review'
        ? reviewNodeFrom(node, fallbackReads)
        : workerNodeFrom(node, role)
      : node
  )
  if (stage.nodes.length === 1) {
    const only = stage.nodes[0]!
    const renamed = mintNodeId(plan, role === 'review' ? 'review' : role)
    nodes = rewireReferences(
      nodes.map((node) => (node.id === only.id ? { ...node, id: renamed } : node)),
      only.id,
      [renamed]
    )
  }
  return normalizeComposerPlan(withNodes(plan, nodes), ctx)
}

/** ×N: one stage, N seats, distinct actors while the host has them. */
export function setStageCount(
  plan: WorkPlan,
  stage: ComposerStage,
  count: number,
  ctx: WorkPlanContext
): WorkPlan {
  const node = stage.nodes[0]
  if (!node || stage.nodes.length !== 1) {
    return plan
  }
  const seats = assignSeats(
    ctx,
    count,
    node.actor,
    node.kind === 'review' ? (actor) => mayIssueVerdict(actor.agent, actor.model) : undefined
  )
  const next: ComposerStageNode =
    node.kind === 'review'
      ? { ...node, seats, actor: seats[0]! }
      : { ...node, count: Math.max(1, Math.trunc(count)), seats, actor: seats[0]! }
  return normalizeComposerPlan(
    withNodes(
      plan,
      plan.nodes.map((entry) => (entry.id === node.id ? next : entry))
    ),
    ctx
  )
}

export function setSeatActor(
  plan: WorkPlan,
  nodeId: string,
  seat: number,
  actor: WorkPlanActor,
  ctx: WorkPlanContext
): WorkPlan {
  const nodes = plan.nodes.map((node) => {
    if (node.id !== nodeId || !isComposerStageNode(node)) {
      return node
    }
    if (!node.seats?.length) {
      return { ...node, actor }
    }
    const seats = node.seats.map((entry, index) => (index === seat ? actor : entry))
    return { ...node, seats, actor: seats[0]! }
  })
  return normalizeComposerPlan(withNodes(plan, nodes), ctx)
}

/**
 * An empty instruction means "the role's own words, written against this Outcome": the dialog
 * shows that text pre-filled, and typing it back unchanged stores nothing, so the plan keeps
 * following the Outcome as it is edited instead of freezing one render of it.
 */
export function setStageInstruction(
  plan: WorkPlan,
  stage: ComposerStage,
  text: string,
  prefilled: string
): WorkPlan {
  const instruction = !text.trim() || text.trim() === prefilled.trim() ? '' : text
  const ids = new Set(stageIds(stage))
  return withNodes(
    plan,
    plan.nodes.map((node) =>
      isComposerStageNode(node) && ids.has(node.id) ? { ...node, instruction } : node
    )
  )
}

export function setReviewLoop(
  plan: WorkPlan,
  nodeId: string,
  patch: { maxRounds?: number; stop?: WorkPlanReviewStop }
): WorkPlan {
  return withNodes(
    plan,
    plan.nodes.map((node) =>
      node.id === nodeId && node.kind === 'review'
        ? {
            ...node,
            ...(patch.maxRounds === undefined
              ? {}
              : { maxRounds: Math.max(1, Math.trunc(patch.maxRounds)) }),
            ...(patch.stop === undefined ? {} : { stop: patch.stop })
          }
        : node
    )
  )
}

export function setFinishHow(
  plan: WorkPlan,
  how: WorkPlanFinishNode['how'],
  ctx: WorkPlanContext
): WorkPlan {
  return normalizeComposerPlan(
    withNodes(
      plan,
      plan.nodes.map((node) => (node.kind === 'finish' ? { ...node, how } : node))
    ),
    ctx
  )
}
