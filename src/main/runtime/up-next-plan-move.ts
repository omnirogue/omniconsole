/**
 * Removing and moving a block that is already queued.
 *
 * Neither is an edit of a running plan: both re-author the plan and commit it as the next
 * VERSION of the same pursuit (`commitWorkPlan` with the existing chain), so v1's steps,
 * attempts and receipts stay addressable and nothing is erased — the frozen model's rule 7.
 * The commit refuses outright while any attempt is launching, running or unverifiable,
 * which is why a running stage cannot be moved or removed by anyone.
 *
 * A PERSON block is not a stage: the people ARE the plan's finish, so removing one drops the
 * finish's own route (`upNextPlanWithoutPeople`) and there is nowhere BELOW the end of the
 * track to go. A queued Review still moves earlier, by holding the stage above it behind the
 * review rather than by swapping nodes (`upNextHoldBehindReview`).
 */

import type { UpNextDraftEntry } from '../../shared/up-next-draft-schema'
import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_REFUSAL_KEYS,
  type UpNextBlock,
  type UpNextPersonBlock
} from '../../shared/up-next-types'
import {
  isWorkPlanOutcomeGate,
  type WorkPlan,
  type WorkPlanNode
} from '../../shared/work-plan-types'
import { upNextChainFor } from './up-next'
import { isUpNextDraftBlockId } from './up-next-draft-blocks'
import { upNextDraftEntryFor } from './up-next-draft-move'
import {
  upNextCommitPlan,
  upNextPlanOf,
  upNextPlanWithoutPeople,
  type UpNextPlanContext
} from './up-next-plan-edit'
import { upNextConversationOf, type UpNextCommitContext } from './up-next-commit'

type WorkNode = Exclude<WorkPlanNode, { kind: 'finish' }>

/** The plan nodes one Up next block stands for: a whole composer stage, or one node. */
function nodesOf(plan: WorkPlan, block: UpNextBlock): WorkPlanNode[] {
  const node = block.id.startsWith(UP_NEXT_BLOCK_ID.planNode)
    ? block.id.slice(UP_NEXT_BLOCK_ID.planNode.length)
    : null
  const named = plan.nodes.find((entry) => entry.id === node)
  if (!named || named.kind === 'finish') {
    return []
  }
  const stage = named.stage?.id
  return stage
    ? plan.nodes.filter((entry) => entry.kind !== 'finish' && entry.stage?.id === stage)
    : [named]
}

/** The plan as it stands, and the context to commit its next version through. */
function authored(ctx: UpNextCommitContext): { plan: UpNextPlanContext; work: WorkPlan } {
  const existing = upNextChainFor(ctx.runtime, ctx.rowKey)
  if (!existing?.outcomeSet) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.unknownBlock)
  }
  const agent = ctx.runtime.conversationAgent(upNextConversationOf(ctx).paneKey)
  const plan: UpNextPlanContext = {
    runtime: ctx.runtime,
    agent: agent ?? 'claude',
    chain: existing,
    existing
  }
  return { plan, work: upNextPlanOf(plan, existing.outcomeSet.outcomes[0]?.title ?? 'Up next') }
}

async function recommit(
  ctx: UpNextCommitContext,
  block: UpNextBlock,
  reason: string,
  mutate: (plan: WorkPlan, nodes: readonly WorkPlanNode[]) => WorkPlan
): Promise<void> {
  const { plan, work } = authored(ctx)
  const nodes = nodesOf(work, block)
  if (!nodes.length) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.unknownBlock)
  }
  await upNextCommitPlan(plan, mutate(work, nodes), reason)
}

/** The stage is dropped from the plan; what it already produced stays as history. */
export async function upNextRecommitWithout(
  ctx: UpNextCommitContext,
  block: UpNextBlock
): Promise<void> {
  if (block.kind === 'person') {
    // The request is not re-authored, so it is not asked again; what the people already
    // answered stays in the receipts of the version that asked them.
    const { plan, work } = authored(ctx)
    await upNextCommitPlan(
      plan,
      upNextPlanWithoutPeople(work),
      'Removed a queued person from Up next.'
    )
    return
  }
  await recommit(ctx, block, 'Removed a queued stage from Up next.', withoutNodes)
}

/** The plan without these nodes, and with nothing left reading or judging them. */
function withoutNodes(plan: WorkPlan, nodes: readonly WorkPlanNode[]): WorkPlan {
  const dropped = new Set(nodes.map((node) => node.id))
  return {
    ...plan,
    nodes: plan.nodes
      .filter((node) => !dropped.has(node.id))
      .map((node) =>
        node.kind === 'finish'
          ? node
          : {
              ...node,
              ...(node.readsFrom
                ? { readsFrom: node.readsFrom.filter((id) => !dropped.has(id)) }
                : {}),
              ...(node.verdict
                ? {
                    verdict: {
                      ...node.verdict,
                      over: node.verdict.over.filter((id) => !dropped.has(id))
                    }
                  }
                : {})
            }
      )
  }
}

/**
 * A queued Review moves EARLIER by taking the stage above it out of the plan and HOLDING that
 * stage behind the review instead.
 *
 * The people are the plan's own finish (`upNextPlanWithPeople`), so a review is the last thing
 * the plan carries and there is no node to trade places with. What the person means by moving
 * it up is "these people see the work before that stage runs", and the engine has always had a
 * way to say exactly that: work composed behind a review is held, and the host commits it as
 * the next plan version the moment they reply (`up-next-continuation.ts`). So the stage leaves
 * the plan through the same door removing it uses — receipts and order intact — and comes back
 * as the held block it now is. Nothing is lost: it is still in Up next, still the person's to
 * edit or remove, and `discard drafts` does not take it (`upNextDiscardDrafts`).
 *
 * The draft is written BEFORE the plan commit on purpose: the plan's own flush is a whole-state
 * write, so both land in one moment. A crash between two writes is what resurrects work.
 */
export async function upNextHoldBehindReview(
  ctx: UpNextCommitContext,
  review: UpNextPersonBlock,
  above: UpNextBlock
): Promise<void> {
  if (review.relationship !== 'review' || !review.stepId) {
    // A handoff is where the work ENDS: there is nothing after it to hold.
    throw new Error(UP_NEXT_REFUSAL_KEYS.capIsTerminal)
  }
  if (above.kind !== 'agent' || isUpNextDraftBlockId(above.id)) {
    // Only a queued stage can be put behind the review. A composed row above it is not in the
    // plan at all — moving THAT one down is its own ↓ — and a prompt belongs to its stage.
    throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
  }
  const previous = ctx.runtime.readUpNextDrafts(ctx.rowKey)?.entries ?? []
  const held: UpNextDraftEntry = {
    ...upNextDraftEntryFor(
      {
        kind: 'agent',
        template: above.template,
        shape: above.shape,
        n: above.n,
        ...(above.instruction ? { instruction: above.instruction } : {}),
        advanced: above.advanced
      },
      {}
    ),
    held: { reviewStepId: review.stepId, committedAt: Date.now() }
  }
  ctx.runtime.replaceUpNextDrafts(ctx.conversationId, [...previous, held])
  try {
    await recommit(ctx, above, 'Moved a person review ahead of a queued stage.', withoutNodes)
  } catch (error) {
    ctx.runtime.replaceUpNextDrafts(ctx.conversationId, previous)
    throw error
  }
}

/** The composer stages of a plan, in plan order: one entry per block the person sees. */
function stagesOf(plan: WorkPlan): WorkNode[][] {
  const stages: WorkNode[][] = []
  for (const node of plan.nodes.filter((entry): entry is WorkNode => entry.kind !== 'finish')) {
    const key = node.stage?.id ?? node.id
    const last = stages.at(-1)
    if (last && (last[0]!.stage?.id ?? last[0]!.id) === key) {
      last.push(node)
    } else {
      stages.push([node])
    }
  }
  return stages
}

/**
 * What a stage hands on: the nodes of it nothing else in it reads. A council is answers →
 * critiques → judge → winner, and what the NEXT stage reads is the winner, not the answers.
 */
function terminalsOf(stage: readonly WorkNode[]): string[] {
  const own = new Set(stage.map((node) => node.id))
  const read = new Set(stage.flatMap((node) => (node.readsFrom ?? []).filter((id) => own.has(id))))
  const terminals = stage.filter((node) => !read.has(node.id))
  return (terminals.length ? terminals : stage).map((node) => node.id)
}

/**
 * Re-wires one stage's INPUTS to whatever now runs before it.
 *
 * Only the nodes that enter the stage are re-pointed — the ones reading nothing inside it —
 * so a shape's own wiring (a judge over its answers, a critique of one seat) is untouched.
 * A verdict may only range over what its own node was given, so `over` follows the same
 * edge; an outcome gate's `over` names done-when entries, not nodes, and is left alone
 * (`isWorkPlanOutcomeGate` below — the plan is refused outright when it is not).
 */
function readingFrom(stage: readonly WorkNode[], predecessor: readonly string[]): WorkNode[] {
  const own = new Set(stage.map((node) => node.id))
  return stage.map((node) => {
    if ((node.readsFrom ?? []).some((id) => own.has(id))) {
      return node
    }
    const reads = [...predecessor]
    const over = node.verdict?.over ?? []
    const kept = over.filter((id) => own.has(id))
    // An outcome GATE's `over` is the Done When entries it judges, so following the input edge
    // would point it at nodes — which `verify-over-done-when` refuses, and at position 0 it
    // would empty the verdict outright (`verdict-over-empty`). The rule this file always
    // stated, now the rule it keeps: only a verdict over NODES follows the edge.
    const rewire = node.verdict && !isWorkPlanOutcomeGate(node) && kept.length !== over.length
    return {
      ...node,
      readsFrom: reads,
      ...(rewire ? { verdict: { ...node.verdict!, over: [...new Set([...kept, ...reads])] } } : {})
    }
  })
}

/**
 * The stage swaps places with the stage beside it, and the edges follow.
 *
 * Reordering used to move the nodes and leave their wiring behind, so the plan said "B reads
 * A" while B ran first and the commit was refused (`reads-from-not-earlier`). The two swapped
 * stages and the one after them read from their NEW predecessor; nothing further down the
 * plan changed order, so nothing further down changes its inputs.
 */
export async function upNextRecommitMoved(
  ctx: UpNextCommitContext,
  block: UpNextBlock,
  direction: -1 | 1
): Promise<void> {
  if (block.kind === 'person') {
    // The people are the plan's finish: the track ends at them, and an end has no neighbour
    // BELOW to trade places with. Moving a queued Review earlier is a different thing
    // entirely and has its own door (`upNextHoldBehindReview`).
    throw new Error(UP_NEXT_REFUSAL_KEYS.capIsTerminal)
  }
  await recommit(ctx, block, 'Reordered Up next.', (plan, nodes) => {
    const moving = new Set(nodes.map((node) => node.id))
    const stages = stagesOf(plan)
    const index = stages.findIndex((stage) => stage.some((node) => moving.has(node.id)))
    const target = index + direction
    if (index === -1 || target < 0 || target >= stages.length) {
      throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
    }
    const reordered = [...stages]
    reordered[index] = stages[target]!
    reordered[target] = stages[index]!
    const first = Math.min(index, target)
    const rewired = reordered.map((stage, position) =>
      position >= first && position <= first + 2
        ? readingFrom(stage, position ? terminalsOf(reordered[position - 1]!) : [])
        : stage
    )
    const finish = plan.nodes.filter((node) => node.kind === 'finish')
    return { ...plan, nodes: [...rewired.flat(), ...finish] }
  })
}
