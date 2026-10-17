import { assignSeats } from './work-plan-composer-actors'
import {
  composerFinish,
  composerStages,
  isComposerStageNode,
  type ComposerStage,
  type ComposerStageNode
} from './work-plan-composer-stages'
import {
  WORK_PLAN_READ_ONLY_ROLES,
  workPlanParallelSeats,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanFinishNode,
  type WorkPlanNode,
  type WorkPlanReviewNode,
  type WorkPlanRole,
  type WorkPlanWorkerNode,
  type WorkPlanWrites
} from '../../../../../shared/work-plan-types'

const READ_ONLY: readonly string[] = WORK_PLAN_READ_ONLY_ROLES

/**
 * What a stage says about writing. A reading role reports into its own run folder and the
 * compiler already infers that, so the plan stays silent about it; a writing role says it,
 * because seats side by side may not touch one workspace (no per-seat worktree exists yet).
 */
export function writesFor(role: WorkPlanRole, parallelSeats: number): WorkPlanWrites | undefined {
  if (READ_ONLY.includes(role)) {
    return undefined
  }
  return parallelSeats > 1 ? 'own-output-dir' : 'workspace'
}

export function mintNodeId(plan: WorkPlan, base: string): string {
  let id = base
  let suffix = 2
  while (plan.nodes.some((node) => node.id === id)) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

export function stageIds(stage: ComposerStage): string[] {
  return stage.nodes.map((node) => node.id)
}

export function withNodes(plan: WorkPlan, nodes: WorkPlanNode[]): WorkPlan {
  return { ...plan, nodes }
}

export function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id))
}

/** Every place one node names another, moved onto the nodes that replace it. */
export function rewireReferences(
  nodes: readonly WorkPlanNode[],
  from: string,
  to: readonly string[]
): WorkPlanNode[] {
  const swap = (ids: readonly string[]): string[] =>
    unique(ids.flatMap((id) => (id === from ? [...to] : [id])))
  return nodes.map((node) => {
    if (!isComposerStageNode(node)) {
      return node
    }
    const next = { ...node } as ComposerStageNode
    if (next.readsFrom) {
      next.readsFrom = swap(next.readsFrom)
    }
    if (next.verdict) {
      next.verdict = { ...next.verdict, over: swap(next.verdict.over) }
    }
    if (next.kind === 'worker' && next.readsWinnerOf === from) {
      const first = to[0]
      if (first === undefined) {
        delete next.readsWinnerOf
      } else {
        next.readsWinnerOf = first
      }
    }
    if (next.kind === 'worker' && next.onFail === from) {
      const first = to[0]
      if (first === undefined) {
        delete next.onFail
      } else {
        next.onFail = first
      }
    }
    if (next.kind === 'worker' && next.enabledBy) {
      const first = to[0]
      next.enabledBy =
        first === undefined
          ? next.enabledBy
          : {
              verdict: next.enabledBy.verdict === from ? first : next.enabledBy.verdict,
              seatsOf: next.enabledBy.seatsOf === from ? first : next.enabledBy.seatsOf
            }
    }
    return next
  })
}

/**
 * A stage inserted after another takes over its place in the flow: whatever read the anchor as
 * its predecessor now reads the new work, while a verdict that ranges over the anchor keeps its
 * candidates and gains the new reading. Without this the inserted stage would be invisible to
 * everything downstream and the chain would read as a plan that nothing consumes.
 */
function repoint(
  node: WorkPlanNode,
  anchorIds: readonly string[],
  insertedIds: readonly string[]
): WorkPlanNode {
  if (!isComposerStageNode(node) || anchorIds.length === 0) {
    return node
  }
  const ranges =
    (node.verdict?.over ?? []).some((id) => anchorIds.includes(id)) ||
    (node.kind === 'worker' &&
      node.readsWinnerOf !== undefined &&
      anchorIds.includes(node.readsWinnerOf))
  if (ranges) {
    return node.readsFrom
      ? { ...node, readsFrom: unique([...node.readsFrom, ...insertedIds]) }
      : node
  }
  return node.readsFrom && sameSet(node.readsFrom, anchorIds)
    ? { ...node, readsFrom: [...insertedIds] }
    : node
}

export function insertAfterStage(
  plan: WorkPlan,
  stage: ComposerStage | undefined,
  inserted: readonly ComposerStageNode[]
): WorkPlan {
  const anchorIds = stage ? stageIds(stage) : []
  const finishAt = plan.nodes.findIndex((node) => node.kind === 'finish')
  const at = stage
    ? plan.nodes.findIndex((node) => node.id === anchorIds.at(-1)) + 1
    : finishAt === -1
      ? plan.nodes.length
      : finishAt
  const insertedIds = inserted.map((node) => node.id)
  return withNodes(plan, [
    ...plan.nodes.slice(0, at),
    ...inserted,
    ...plan.nodes.slice(at).map((node) => repoint(node, anchorIds, insertedIds))
  ])
}

function normalizeNode(
  plan: WorkPlan,
  raw: ComposerStageNode,
  ctx: WorkPlanContext
): ComposerStageNode {
  const node = { ...raw } as ComposerStageNode
  if (node.readsFrom && node.readsFrom.length === 0) {
    delete (node as WorkPlanWorkerNode).readsFrom
  }
  if (node.kind === 'review') {
    const seats = node.seats?.length ? node.seats : [node.actor]
    return {
      ...node,
      seats,
      actor: seats[0]!,
      maxRounds: Math.max(1, Math.trunc(node.maxRounds)),
      readsFrom: node.readsFrom ?? []
    } satisfies WorkPlanReviewNode
  }
  const count = Math.max(1, Math.trunc(node.count ?? 1))
  if (count <= 1) {
    delete node.count
    delete node.seats
  } else {
    node.count = count
    node.seats = node.seats?.length === count ? node.seats : assignSeats(ctx, count, node.actor)
    node.actor = node.seats[0]!
  }
  const parallel = node.group ? workPlanParallelSeats(plan, node) : count
  const writes = writesFor(node.role, parallel)
  if (writes) {
    node.writes = writes
  } else {
    delete node.writes
  }
  return node
}

/**
 * The shape of a plan the dialog is willing to show: one finish, last, routed to the person when
 * they are the one who decides. Everything else is the person's; this only removes what would
 * make the drawing lie (a seat list that does not match ×N, a write claim a reading role cannot
 * make, an empty "reads exactly these" that means nothing).
 */
export function normalizeComposerPlan(plan: WorkPlan, ctx: WorkPlanContext): WorkPlan {
  const finish = composerFinish(plan)
  const how = finish?.how ?? (plan.outcome.outputKind === 'work' ? 'my-review' : 'complete')
  const stages = plan.nodes.filter(isComposerStageNode)
  const nodes: WorkPlanNode[] = stages.map((node) => normalizeNode(plan, node, ctx))
  nodes.push({
    kind: 'finish',
    id: finish?.id ?? mintNodeId(plan, 'finish'),
    how,
    ...(how === 'my-review' ? { route: 'human' as const } : {})
  } satisfies WorkPlanFinishNode)
  return withNodes(plan, nodes)
}

/** After a move an edge may point at work that now runs later; those edges fall back to order. */
export function renormalizeEdges(plan: WorkPlan): WorkPlan {
  const stages = composerStages(plan)
  const nodes = plan.nodes.map((node) => {
    if (!isComposerStageNode(node)) {
      return node
    }
    const stageAt = stages.findIndex((stage) => stage.nodes.some((entry) => entry.id === node.id))
    const earlier = new Set(
      stages.slice(0, Math.max(0, stageAt)).flatMap((stage) => stageIds(stage))
    )
    const next = { ...node } as ComposerStageNode
    const kept = (next.readsFrom ?? []).filter((id) => earlier.has(id))
    const fallback = stageAt > 0 ? stageIds(stages[stageAt - 1]!) : []
    if (next.readsFrom) {
      const reads = kept.length ? kept : fallback
      if (reads.length) {
        next.readsFrom = reads
      } else {
        delete (next as WorkPlanWorkerNode).readsFrom
      }
    }
    if (next.kind === 'worker' && next.readsWinnerOf && !earlier.has(next.readsWinnerOf)) {
      delete next.readsWinnerOf
    }
    return next
  })
  return withNodes(plan, nodes)
}
