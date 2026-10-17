/**
 * Turning composed blocks into a plan — through the ONE lowering the engine already has.
 *
 * Nothing here compiles a step, mints an outcome or writes a chain itself. It authors a
 * `WorkPlan` (the composer's model) and hands it to `commitWorkPlan`, which lowers it to
 * exactly one Outcome definition and commits it under the host's own CAS. That is why
 * changing strategy, reordering a queued stage and adding one all behave the same way: they
 * are the same commit with a different plan.
 */

import { appendWorkPlanFragment, workPlanRoleVerdicts } from '../../shared/work-plan-fragments'
import {
  commitWorkPlan,
  type WorkPlanCommitMode,
  type WorkPlanCommitRequest
} from '../../shared/work-plan-commit'
import type { SessionChain, SessionChainStepStage } from '../../shared/session-chain-types'
import type { NextOutcomeTeamUsableAgent } from '../../shared/next-outcome-team-plan-schema'
import type { SessionFollowUpTranscriptSource } from '../../shared/session-follow-up-transcript'
import type { TuiAgent } from '../../shared/tui-agent'
import { workPlanFromChain } from '../../shared/work-plan-read'
import { workPlanFromShape, type WorkPlanShape } from '../../shared/work-plan-shapes'
import {
  WORK_PLAN_ROLE_PRESET,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanFinishPeople,
  type WorkPlanRole
} from '../../shared/work-plan-types'
import {
  UP_NEXT_REFUSAL_KEYS,
  type UpNextAgentBlock,
  type UpNextAgentShape
} from '../../shared/up-next-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { launchedUsableAgents, mergeUsableAgents, usableAgentActors } from './up-next-plan-actors'
import { upNextPlanWithAdvanced, upNextStageReadsFrom } from './up-next-plan-advanced'

/** The composer's words for a stage, in the shapes the plan engine builds. */
const SHAPES: Record<UpNextAgentShape, WorkPlanShape | null> = {
  solo: 'solo',
  parallel: 'parallel',
  council: 'council',
  'best-of': 'bestOfN',
  // A custom topology is drawn in the work-plan dialog (WP-9a), not described by a block.
  custom: null
}

export function upNextShape(shape: UpNextAgentShape): WorkPlanShape {
  const topology = SHAPES[shape]
  if (!topology) {
    throw new Error('A custom stage is drawn in the plan composer.')
  }
  return topology
}

/** A role every template maps to; `custom` is an instruction the person wrote themselves. */
export function upNextRole(block: UpNextAgentBlock): WorkPlanRole {
  if (block.template === 'custom') {
    return 'implement'
  }
  const role = (Object.keys(WORK_PLAN_ROLE_PRESET) as WorkPlanRole[]).find(
    (candidate) => WORK_PLAN_ROLE_PRESET[candidate] === block.template
  )
  return role ?? 'implement'
}

export type UpNextPlanContext = {
  runtime: OrcaRuntimeService
  agent: TuiAgent
  chain: SessionChain
  existing: SessionChain | null
  /**
   * What this host can launch, probed once for the commit that needed to know (a Council or a
   * Best-of-N needs a judge from a second model family). Absent is not "nothing usable": the
   * conversation's own agent and every actor the chain already launched are always usable.
   */
  catalogue?: readonly NextOutcomeTeamUsableAgent[]
  /**
   * Every stage THIS commit is composing. The model and effort the person picked in Advanced are
   * facts about the commit, not about one shape build: the plan is lowered ONCE, with every seat
   * in it, so the catalogue the lowering validates against has to name them all. Without this a
   * stage built with `claude opus-4` was compiled and then refused by the same commit
   * ("claude opus-4 is not usable on this host"), which is what happened to every explicit model
   * choice unless a Council in the same commit had probed the host or an earlier seat had already
   * run that exact model.
   */
  composing?: readonly UpNextAgentBlock[]
}

/** The model and effort a person picked for a stage, as a one-entry catalogue. */
function chosenAgents(
  ctx: UpNextPlanContext,
  blocks: readonly UpNextAgentBlock[]
): NextOutcomeTeamUsableAgent[] {
  return blocks
    .filter((block) => block.advanced.model)
    .map((block) => ({
      agent: ctx.agent,
      models: [
        {
          id: block.advanced.model!,
          label: block.advanced.model!,
          efforts: block.advanced.effort ? [block.advanced.effort] : []
        }
      ]
    }))
}

/**
 * Who may be seated, for THIS commit. Built from facts, never from a guess: the conversation's
 * own agent, the exact model and effort the person picked for every stage the commit is composing,
 * every actor the chain has already launched (so re-reading its own plan can never refuse a seat it
 * is running), and the host's probed catalogue when a shape needed a second family.
 */
function usableAgents(
  ctx: UpNextPlanContext,
  block?: UpNextAgentBlock
): NextOutcomeTeamUsableAgent[] {
  return mergeUsableAgents([
    [{ agent: ctx.agent, models: [] }],
    chosenAgents(ctx, [...(ctx.composing ?? []), ...(block ? [block] : [])]),
    launchedUsableAgents(ctx.existing),
    ctx.catalogue ?? []
  ])
}

function planContext(ctx: UpNextPlanContext, block?: UpNextAgentBlock): WorkPlanContext {
  return {
    usableAgents: usableAgents(ctx, block),
    source: null,
    placement: 'local',
    accountCatalogue: [],
    ...(ctx.existing ? { existingChain: ctx.existing } : {}),
    commitSource: 'user',
    capabilities: { sameConversationRoute: false }
  }
}

function stageOf(block: UpNextAgentBlock): SessionChainStepStage {
  return { id: `stage-${block.id}`, shape: block.shape, width: Math.max(1, block.n) }
}

/**
 * The plan as it stands: what the chain already carries, or a new one for this outcome.
 *
 * A first commit with no Outcome typed yet is still a pursuit, and every Outcome needs at
 * least one Done When — so it gets the one the ＋ Next flow has always used: the work comes
 * back to the person, and it is done when they have reviewed it. Editing the Outcome line
 * (NA-4) replaces it; nothing here invents a mechanical criterion on the person's behalf.
 */
export function upNextPlanOf(
  ctx: UpNextPlanContext,
  title: string,
  options: { myReview?: boolean; verified?: boolean } = {}
): WorkPlan {
  if (ctx.existing?.outcomeSet) {
    const plan = workPlanFromChain(ctx.existing)
    return options.verified && !upNextVerifiable(plan)
      ? {
          ...plan,
          outcome: {
            ...plan.outcome,
            doneWhen: [
              ...plan.outcome.doneWhen,
              { id: 'verified', text: 'Verify reports pass', evidence: 'verdict' }
            ]
          }
        }
      : plan
  }
  return {
    outcome: {
      title,
      doneWhen: [
        // Work that ends AT A PERSON is theirs to answer: waiting for the owner's review as
        // well would make the Outcome need two people, which is not what was composed.
        ...(options.myReview === false
          ? []
          : [{ id: 'my-review', text: 'I have reviewed the result', evidence: 'human' as const }]),
        // A Verify stage decides pass or fail on the Done When entries, so composing one
        // states a criterion: the Outcome is reached when Verify passes. Without this the
        // stage would judge nothing, and the validator would rightly refuse it.
        ...(options.verified
          ? [{ id: 'verified', text: 'Verify reports pass', evidence: 'verdict' as const }]
          : [])
      ],
      outputKind: 'work'
    },
    nodes: []
  }
}

/** A Verify stage needs something to judge; on an existing Outcome only its owner adds one. */
export function upNextVerifiable(plan: WorkPlan): boolean {
  return plan.outcome.doneWhen.some(
    (entry) => entry.evidence === 'verdict' || entry.evidence === 'report'
  )
}

/**
 * Adds one composed stage to the plan: the first one starts it, the rest extend it.
 *
 * `afterNodeId` is the stage the person put this one AFTER — the queued block directly above
 * it in Up next. Without it a new stage extends the last node, which is right for a stage
 * composed at the end and wrong for one anchored mid-chain: what is shown is what will
 * execute, in that order, so the anchor decides where it goes in the plan.
 */
export function upNextPlanWithStage(
  ctx: UpNextPlanContext,
  plan: WorkPlan,
  block: UpNextAgentBlock,
  afterNodeId?: string
): WorkPlan {
  const stage = stageOf(block)
  const role = upNextRole(block)
  const topology = upNextShape(block.shape)
  const named = afterNodeId
    ? plan.nodes.find((node) => node.id === afterNodeId && node.kind !== 'finish')
    : undefined
  const anchor = named ?? plan.nodes.findLast((node) => node.kind !== 'finish')
  if (!anchor) {
    const created = workPlanFromShape(topology, {
      prompt: block.instruction,
      outcome: plan.outcome,
      planMode: false,
      ctx: planContext(ctx, block),
      seats: block.n,
      stage
    })
    return upNextPlanWithAdvanced(
      {
        ...created,
        nodes: created.nodes.map((node) =>
          node.kind === 'worker' && !node.readsFrom?.length ? { ...node, role } : node
        )
      },
      block,
      { stageId: stage.id, role }
    )
  }
  const actors = usableAgentActors(ctx.catalogue ?? [])
  const readsFrom = upNextStageReadsFrom(plan, block)
  const appended = appendWorkPlanFragment(plan, anchor.id, {
    action: role,
    topology,
    route: 'new-session',
    actor: {
      agent: ctx.agent,
      ...(block.advanced.model ? { model: block.advanced.model } : {}),
      ...(block.advanced.effort ? { effort: block.advanced.effort } : {})
    },
    ...(actors.length ? { actors } : {}),
    ...(block.instruction ? { instruction: block.instruction } : {}),
    ...(readsFrom.length ? { readsFrom } : {}),
    seats: block.n,
    stage
  })
  return upNextPlanWithAdvanced(appended, block, { stageId: stage.id, role })
}

/**
 * The people leave the plan's finish.
 *
 * A review that has been ANSWERED is not an open obligation: its receipts are history, the
 * request is never sent again, and what the Outcome still needs is what the continuation is
 * for. Leaving the condition in would make the Outcome wait for a reply it already had —
 * the revision bump a new criterion causes deliberately discards human-review receipts.
 */
export function upNextPlanWithoutPeople(plan: WorkPlan): WorkPlan {
  return {
    ...plan,
    outcome: {
      ...plan.outcome,
      // With the review answered and no criterion of its own left, the Outcome is what it
      // always is for work that comes back to the person: done when they have reviewed it.
      doneWhen: plan.outcome.doneWhen.length
        ? plan.outcome.doneWhen
        : [{ id: 'my-review', text: 'I have reviewed the result', evidence: 'human' }]
    },
    nodes: plan.nodes.map((node) =>
      node.kind === 'finish' && node.finishWith
        ? { kind: 'finish' as const, id: node.id, how: node.how }
        : node
    )
  }
}

/** The Person block, as the plan's finish: who it goes to, and what that means. */
export function upNextPlanWithPeople(plan: WorkPlan, finishWith: WorkPlanFinishPeople): WorkPlan {
  const nodes = plan.nodes.filter((node) => node.kind !== 'finish')
  return {
    ...plan,
    nodes: [
      ...nodes,
      {
        kind: 'finish',
        id: 'finish',
        how: 'my-review',
        route: 'human',
        finishWith
      }
    ]
  }
}

/**
 * Commits the plan.
 *
 * A `supersede` commit refuses while any attempt of the old plan is still launching, running
 * or unverifiable — which IS the lock rule: work in flight cannot be RE-PLANNED. An `append`
 * commit only adds stages behind it, so it is exactly what "configure a stage after this"
 * needs and it is allowed while that work runs.
 */
export async function upNextCommitPlan(
  ctx: UpNextPlanContext,
  plan: WorkPlan,
  reason: string,
  options: {
    mode?: WorkPlanCommitMode
    transcriptSource?: SessionFollowUpTranscriptSource
    /** This commit carries a Person block: it ASKS, so a second review reaches its own step. */
    asksPeopleAgain?: boolean
  } = {}
): Promise<string> {
  const service = ctx.runtime.getSessionOutcomeService()
  // Every plan leaves through here — queued blocks, a removed stage, a reordered one — and
  // whether a deciding stage's verdict still has a reader is a fact about the plan as it
  // stands. Normalising it at the boundary is what keeps removing the stage a Review fed from
  // being refused because the Review is suddenly deciding for nobody.
  const result = await commitWorkPlan(workPlanRoleVerdicts(plan), {
    ...planContext(ctx),
    chain: ctx.chain,
    ...(ctx.existing ? { existingChain: ctx.existing } : {}),
    commitSessionOutcomes: (request: WorkPlanCommitRequest) =>
      service.commit(request.chain, request),
    supersedeReason: reason,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.asksPeopleAgain ? { asksPeopleAgain: true } : {}),
    ...(options.transcriptSource ? { transcriptSource: options.transcriptSource } : {})
  })
  if ('problems' in result) {
    throw new Error(
      result.problems
        .filter((problem) => problem.severity === 'block')
        .map((problem) => problem.message)
        .join('\n') || UP_NEXT_REFUSAL_KEYS.blockQueued
    )
  }
  return result.chainId
}
