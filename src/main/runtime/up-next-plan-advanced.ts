/**
 * The Advanced row of an Agent block, lowered onto the plan it was composed for.
 *
 * Model and effort ride on the seat itself; the other four are properties of the STAGE and of
 * the plan around it, so they are applied to the nodes one stage minted after the shape built
 * them: rounds + stop rule become the engine's own review loop (`kind: 'review'`, which is the
 * only primitive that repeats a stage and repairs between rounds), reads-from names the stages
 * this one reads instead of the one directly above it, and end-on-success is the plan's finish
 * (`how: 'complete'` — the session ends when the work passes, rather than coming back to the
 * person). Read back from the chain by `up-next-blocks.ts`, which is why each one is written
 * where the projection already looks for it.
 */

import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_REFUSAL_KEYS,
  type UpNextAgentBlock
} from '../../shared/up-next-types'
import {
  WORK_PLAN_MAX_REVIEW_ROUNDS,
  type WorkPlan,
  type WorkPlanNode,
  type WorkPlanReviewNode,
  type WorkPlanRole
} from '../../shared/work-plan-types'

/** Roles whose output IS a verdict over what they read; the rest report a result. */
const VERDICT_ROLES: readonly WorkPlanRole[] = ['review', 'critique']

/** A stage repeats through the review primitive, so rounds only apply to a deciding role. */
export function upNextStageRounds(block: UpNextAgentBlock, role: WorkPlanRole): number {
  const rounds = Math.trunc(block.advanced.rounds ?? 1)
  if (!VERDICT_ROLES.includes(role) || !(rounds > 1)) {
    return 1
  }
  return Math.min(rounds, WORK_PLAN_MAX_REVIEW_ROUNDS)
}

/**
 * The plan node ONE named input stands for, or nothing.
 *
 * Two kinds of block can be read from, and the person picks them from the same list: a stage the
 * chain already carries (`node:<plan node>`) and one composed in the SAME batch, which has no plan
 * node yet — only the draft id the composer gave it. A stage keeps its draft id as its stage marker
 * for good (`stage-<block id>`, `up-next-plan-edit.ts`), so that marker is what resolves a
 * `draft:` input, whether it was queued in this commit or a previous one.
 */
function upNextReadNode(plan: WorkPlan, id: string): string | undefined {
  const own = plan.nodes.filter((node) => node.kind !== 'finish')
  if (id.startsWith(UP_NEXT_BLOCK_ID.planNode)) {
    const node = id.slice(UP_NEXT_BLOCK_ID.planNode.length)
    return own.some((entry) => entry.id === node) ? node : undefined
  }
  return own.findLast((node) => node.stage?.id === `stage-${id}`)?.id
}

/**
 * The plan nodes this stage reads from, named by the person rather than by position.
 *
 * An id that stands for nothing is REFUSED, not dropped: reading the stage above is what the
 * default already means, so a stage that silently read the default instead of the two stages the
 * person ticked would show one thing in the composer and execute another. With nothing named at
 * all the stage keeps the inputs the shape gave it.
 */
export function upNextStageReadsFrom(plan: WorkPlan, block: UpNextAgentBlock): string[] {
  const named = block.advanced.readsFrom ?? []
  const resolved = named.map((id) => {
    const node = upNextReadNode(plan, id)
    if (!node) {
      throw new Error(UP_NEXT_REFUSAL_KEYS.unknownBlock)
    }
    return node
  })
  return [...new Set(resolved)]
}

/** The nodes one composed stage minted: they all carry its stage marker. */
function stageNodes(plan: WorkPlan, stageId: string): WorkPlanNode[] {
  return plan.nodes.filter((node) => node.kind !== 'finish' && node.stage?.id === stageId)
}

/**
 * The stage's first node — the one that reads what came before rather than its own siblings.
 * A shape's convergence (a council's critiques, its judge, its winner) reads inside the stage
 * and is not what rounds, reads-from or the verdict contract are about.
 */
function initialNodes(nodes: readonly WorkPlanNode[]): WorkPlanNode[] {
  const own = new Set(nodes.map((node) => node.id))
  return nodes.filter(
    (node) => node.kind !== 'finish' && !(node.readsFrom ?? []).some((id) => own.has(id))
  )
}

function asReviewNode(node: WorkPlanNode, rounds: number, block: UpNextAgentBlock): WorkPlanNode {
  if (node.kind !== 'worker') {
    return node
  }
  const review: WorkPlanReviewNode = {
    kind: 'review',
    id: node.id,
    actor: node.actor,
    ...(node.seats ? { seats: node.seats } : {}),
    ...(node.stage ? { stage: node.stage } : {}),
    ...(node.route ? { route: node.route } : {}),
    readsFrom: [...(node.readsFrom ?? [])],
    loop: block.template === 'critique' ? 'adversarial' : 'review',
    maxRounds: rounds,
    // The existing primitive stops on zero blockers; any other rule was refused above rather
    // than silently replaced with this one.
    stop: block.advanced.stopWhen ?? 'zero_blockers',
    // A loop GATES: the round's verdict is what decides whether another round runs and what
    // the repair between them has to answer. That is a different contract from a one-shot
    // review, whose findings are merely recorded for the next stage to read.
    verdict: {
      kind: node.verdict?.kind ?? 'review',
      over: [...(node.verdict?.over ?? node.readsFrom ?? [])],
      consumed: 'gate'
    },
    ...(node.instruction ? { instruction: node.instruction } : {})
  }
  return review
}

/**
 * Everything the Advanced row decided, applied to the plan this stage was just added to.
 *
 * `reads` is what the stage's first nodes read when the person did not say; `endOnSuccess`
 * moves the plan's own finish, which is why it is applied here and not per node.
 */
export function upNextPlanWithAdvanced(
  plan: WorkPlan,
  block: UpNextAgentBlock,
  options: { stageId: string; role: WorkPlanRole }
): WorkPlan {
  const nodes = stageNodes(plan, options.stageId)
  const initial = new Set(initialNodes(nodes).map((node) => node.id))
  const rounds = upNextStageRounds(block, options.role)
  // A stop rule the host's loop cannot honour is refused rather than replaced with the one it can.
  // Said once, for every stage: with more than one round the lowering already refuses it, and with
  // one round or none the rule was dropped in silence — the chip vanished after the commit and the
  // stage ran under a rule the person did not choose.
  if (block.advanced.stopWhen && block.advanced.stopWhen !== 'zero_blockers') {
    throw new Error(UP_NEXT_REFUSAL_KEYS.stopRuleUnsupported)
  }
  const readsFrom = upNextStageReadsFrom(plan, block)
  // "Ends session on pass" can only move the finish when the Outcome can be judged WITHOUT
  // the person who asked: a criterion of theirs ("I have reviewed the result") is theirs to
  // remove (NA-4's Outcome line), never this row's. The stage then reads back without the
  // chip, so the panel still shows what will really happen.
  const endOnSuccess =
    block.advanced.endOnSuccess === true &&
    plan.outcome.doneWhen.every((entry) => entry.evidence !== 'human')
  if (!initial.size && !endOnSuccess) {
    return plan
  }
  return {
    ...plan,
    nodes: plan.nodes.map((node) => {
      if (node.kind === 'finish') {
        return endOnSuccess && !node.finishWith ? { ...node, how: 'complete' as const } : node
      }
      if (!initial.has(node.id)) {
        return node
      }
      const wired = readsFrom.length ? { ...node, readsFrom } : node
      return rounds > 1 ? asReviewNode(wired, rounds, block) : wired
    })
  }
}
