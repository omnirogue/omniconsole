/**
 * Queueing what the person composed — once, in order, through the doors that already exist.
 *
 * A commit is three things and nothing more: the composed STAGES and the PERSON become one
 * plan commit (`commitWorkPlan`, which lowers to exactly one Outcome); a prompt to the
 * current agent becomes a prompt-queue entry (the same primitive `/next` uses); a prompt to
 * a stage is attached to that stage's seats, to be delivered into their own conversations
 * when they are idle. Done is the finish intent on the outcome set.
 *
 * It is all-or-nothing in the order that matters: the plan first, so a prompt can only ever
 * be attached to a stage that really exists, and the drafts are cleared last.
 */

import { randomUUID } from 'node:crypto'
import type { ConversationSource } from '../../shared/conversation-source'
import { sendConversationPromptNow } from './conversation-prompt-now'
import { isSessionChainAgentStep, type SessionChain } from '../../shared/session-chain-types'
import type { SessionFinishChoice } from '../../shared/session-finish-intent'
import type { TuiAgent } from '../../shared/tui-agent'
import { upNextIsEndCap } from '../../shared/up-next-order'
import { upNextSendEnd, upNextWithSendChoices } from '../../shared/up-next-person-send'
import {
  isUpNextConversation,
  UP_NEXT_REFUSAL_KEYS,
  type UpNextAgentBlock,
  type UpNextBlock,
  type UpNextConversationId,
  type UpNextDoneBlock,
  type UpNextPersonBlock,
  type UpNextPromptBlock,
  type UpNextView
} from '../../shared/up-next-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { nextSessionOutcomeSourceId } from './session-outcome-source-uniqueness'
import { upNextChainFor } from './up-next'
import {
  upNextAnchorNodeFor,
  upNextOpenReviewIndex,
  upNextReviewStepFor
} from './up-next-commit-gates'
import { upNextCommitFinish } from './up-next-commit-finish'
import { isUpNextDraftBlockId } from './up-next-draft-blocks'
import { upNextCommitTitle, upNextFinishWith } from './up-next-person-commit'
import { probeUsableAgents } from './up-next-plan-actors'
import { upNextAttachStagePrompts } from './up-next-stage-prompts'
import {
  upNextCommitPlan,
  upNextPlanOf,
  upNextPlanWithoutPeople,
  upNextPlanWithPeople,
  upNextPlanWithStage,
  type UpNextPlanContext
} from './up-next-plan-edit'

export type UpNextCommitContext = {
  runtime: OrcaRuntimeService
  conversationId: UpNextConversationId
  rowKey: string
}

/**
 * Queueing work needs a conversation: a thread or a card is composed on, but the blocks run
 * in the session its own surface starts (the inbox thread's and the card's existing launch
 * doors). Until then there is nothing to queue into and nothing to interrupt.
 */
export function upNextConversationOf(ctx: UpNextCommitContext): ConversationSource {
  if (!isUpNextConversation(ctx.conversationId)) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.subjectNotStarted)
  }
  return ctx.conversationId
}

/** The chain this commit continues, or the record a first commit will create. */
export async function upNextBaseChain(
  ctx: UpNextCommitContext,
  existing: SessionChain | null
): Promise<SessionChain> {
  if (existing) {
    return existing
  }
  const conversation = upNextConversationOf(ctx)
  const workspace = await ctx.runtime.showManagedTerminalWorkspace(`id:${conversation.worktreeId}`)
  const now = Date.now()
  const source = {
    sourcePaneKey: conversation.paneKey,
    worktreeId: conversation.worktreeId
  } as SessionChain
  return {
    id: nextSessionOutcomeSourceId(ctx.runtime.listSessionChains(), source),
    sourcePaneKey: conversation.paneKey,
    sourceRowKey: ctx.rowKey,
    worktreeId: conversation.worktreeId,
    workspacePath: workspace.path,
    hostId: 'local',
    placement: 'local',
    auto: true,
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    createdAt: now,
    updatedAt: now
  }
}

/** A prompt to the current agent: sent now if that is what the person chose, else queued. */
async function commitPrompt(ctx: UpNextCommitContext, block: UpNextPromptBlock): Promise<void> {
  if (block.when === 'now') {
    // The person asked to interrupt, so it does not wait for the agent to be free.
    await sendConversationPromptNow(
      ctx.runtime,
      upNextConversationOf(ctx),
      { id: `up-next-${randomUUID()}`, text: block.text },
      ctx.runtime.getSessionOutcomeService().epoch
    )
    return
  }
  ctx.runtime.enqueuePromptQueueEntry(upNextConversationOf(ctx), {
    id: `up-next-${randomUUID()}`,
    text: block.text,
    createdAt: Date.now(),
    state: 'queued'
  })
}

/**
 * Done finishes the work. It lives beside this file because it is the one commit that writes
 * no plan: `upNextCommitFinish` is re-exported here so every caller keeps one door.
 */
export {
  upNextCommitFinish,
  upNextFinishChoiceOf,
  type UpNextFinishResult
} from './up-next-commit-finish'

const KINDS = ['agent', 'person', 'done'] as const

/**
 * What is shown is what will execute, in that order.
 *
 * The lowering has exactly ONE place for people and for the finish — the plan's own finish
 * node — so a chain that shows work AFTER an end cap cannot be queued in the order it was
 * shown. It is refused here rather than silently re-grouped into stages-then-people, which
 * would run the work the person put last first. Composing that shape is already refused on
 * the add and the update paths; this is the boundary that makes it an invariant.
 */
function refuseOutOfShownOrder(blocks: readonly UpNextBlock[]): void {
  const terminal = blocks.findIndex(upNextIsEndCap)
  if (terminal !== -1 && terminal < blocks.length - 1) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
  }
}

export type UpNextCommitSelection = {
  /** Commit only the composed blocks this answers true for; the rest keep waiting. */
  only?: (block: UpNextBlock) => boolean
  /**
   * This commit IS the host resuming what a review held: the gate the reviewers opened is
   * already open, so those blocks are queued rather than held behind the same review again,
   * and the review's own obligations are not authored a second time.
   */
  resumed?: boolean
  /** What the reviewers replied, for the stages a resumed commit releases (`up-next-review-brief.ts`). */
  replies?: string
  /** The run a resumed commit continues: the one whose review released it. */
  run?: SessionChain
}

export type UpNextCommitResult = {
  committed: string[]
  heldAfter: string[]
  /** The review step the held blocks are waiting on; the caller writes it back with them. */
  reviewStepId?: string
  /** Done had no pursuit to record it on: the surface's own finish door performs this. */
  finish?: SessionFinishChoice
}

/**
 * The agent the run's last stage ran on, for the host resuming held work on a conversation whose
 * agent it cannot read right now (an idle pane started from a shell). A judge is left out: it is
 * chosen from a different family on purpose, so it names nothing about this conversation.
 */
function upNextRunAgent(run: SessionChain | undefined): TuiAgent | null {
  return run?.steps.filter(isSessionChainAgentStep).findLast((step) => !step.verdict)?.agent ?? null
}

/**
 * The blocks a caller NAMED, as a selection — a reading of the list the person saw, so it lives
 * beside the other two (`up-next-commit-gates.ts`) and is re-exported here to keep one door.
 */
export { upNextNamedSelection } from './up-next-commit-gates'

/**
 * Everything the person composed, queued in one go. Returns the ids that were committed.
 *
 * Blocks composed AFTER a person review are not committed with it: the plan's finish is
 * where people receive the work, so a stage behind a review would run before they ever saw
 * it. They are HELD by the host instead — the caller writes them back with their review —
 * and committed the moment every reviewer has replied. That is true of the review this commit
 * adds AND of one the chain asked earlier and is still waiting on; once it has come back,
 * what the person composes behind it is ordinary work and commits straight through.
 *
 * A send that does NOT wait ends the track, so nothing composed behind it is committed: those
 * blocks stay drafts, marked "won't run" in the composer, and the send itself commits.
 */
export async function upNextCommitDrafts(
  ctx: UpNextCommitContext,
  shown: UpNextView,
  selection: UpNextCommitSelection = {}
): Promise<UpNextCommitResult> {
  // Every send nobody ticked commits as its default, read off the same list the person saw.
  const view: UpNextView = { ...shown, blocks: upNextWithSendChoices(shown.blocks) }
  const end = upNextSendEnd(view.blocks)
  const composed = view.blocks.filter(
    (block, index) =>
      isUpNextDraftBlockId(block.id) &&
      (end === -1 || index <= end) &&
      (selection.only?.(block) ?? true) &&
      (selection.resumed || !block.heldFor)
  )
  if (!composed.length) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.noDrafts)
  }
  const chain = selection.run ?? upNextChainFor(ctx.runtime, ctx.rowKey)
  // A review only holds what the person composed BEHIND it — the review being composed here,
  // or one that is still out. A review already answered holds nothing.
  const composedReview = composed.find(
    (block) => block.kind === 'person' && block.relationship === 'review'
  )
  // The EARLIEST review that has not been answered: the one still out, or the one this commit
  // adds. Taking the later of the two made a nested second review its own gate, so Improve and
  // Review 2 were queued while the first reviewers were still reading — and committing Review 2
  // replaced the finish, which dropped Review 1's own condition and left the work behind it held
  // on a reply that could never be counted. That is also why `resumed` is not a case of its own:
  // the gate that released this commit has been answered, so it holds nothing by this reading,
  // and a review still out (or one held with the work) goes on holding what sits behind it.
  const unanswered = [
    composedReview ? view.blocks.indexOf(composedReview) : -1,
    upNextOpenReviewIndex(view, chain)
  ].filter((index) => index !== -1)
  const gate = unanswered.length ? Math.min(...unanswered) : -1
  const behindReview = (block: UpNextBlock): boolean =>
    gate !== -1 && view.blocks.indexOf(block) > gate
  const drafts = composed.filter((block) => !behindReview(block))
  const heldAfter = composed.filter(behindReview)
  refuseOutOfShownOrder(drafts)
  const stages = drafts.filter((block): block is UpNextAgentBlock => block.kind === 'agent')
  const person = drafts.find((block): block is UpNextPersonBlock => block.kind === 'person')
  const done = drafts.find((block): block is UpNextDoneBlock => block.kind === 'done')
  const planned = drafts.filter((block) => (KINDS as readonly string[]).includes(block.kind))
  let finish: SessionFinishChoice | undefined
  if (planned.length) {
    const conversation = upNextConversationOf(ctx)
    const agent =
      ctx.runtime.conversationAgent(conversation.paneKey) ??
      (selection.resumed ? upNextRunAgent(selection.run) : null)
    if (!agent && stages.length) {
      throw new Error(UP_NEXT_REFUSAL_KEYS.needsAgent)
    }
    const base = await upNextBaseChain(ctx, chain)
    const plan: UpNextPlanContext = {
      runtime: ctx.runtime,
      agent: agent ?? 'claude',
      chain: base,
      existing: chain,
      // Every stage this commit composes, so the model the person chose for ANY of them is usable
      // for the whole commit — the shape build and the plan commit are one decision.
      composing: stages,
      // A Council or a Best-of-N needs a judge from a different family than the candidates,
      // so THAT commit asks the host what it can really launch. Nothing else pays for it.
      ...(stages.some((block) => block.shape === 'council' || block.shape === 'best-of')
        ? {
            catalogue: await probeUsableAgents(
              ctx.runtime,
              `id:${base.sourceWorktreeId ?? base.worktreeId}`
            )
          }
        : {})
    }
    if (stages.length || person) {
      // Everything the person composed decides what the Outcome needs, including the blocks
      // this commit will HOLD: a Verify at the end states a criterion the Outcome is judged
      // on, and it has to exist before the stage that judges it is compiled.
      // A Verify stage judges the Done When entries, so composing one states a criterion —
      // added with the stage itself, never before it, because a criterion with no verifier
      // has nothing to prove it.
      let authored = upNextPlanOf(plan, upNextCommitTitle(view, stages), {
        // End-on-success means the session ends when the work PASSES, so the Outcome does not
        // also wait for the person who asked to review it — but only when something in the
        // plan can say it passed. With nothing to judge it, the work still comes back to them.
        myReview:
          !person &&
          !(
            stages.some((block) => block.advanced.endOnSuccess) &&
            stages.some((block) => block.template === 'verify')
          ),
        verified: stages.some((block) => block.template === 'verify')
      })
      if (selection.resumed) {
        authored = upNextPlanWithoutPeople(authored)
      }
      // What each composed stage minted, so the NEXT one can be anchored to the sibling shown
      // above it rather than to whatever node happens to be last in the plan.
      const minted = new Map<string, string>()
      for (const stage of stages) {
        const before = new Set(authored.nodes.map((node) => node.id))
        authored = upNextPlanWithStage(
          plan,
          authored,
          // The reviewers' words ride in the stage's own instruction; the anchor is read off the
          // block the view shows, which is why the copy is made only for the plan.
          selection.replies
            ? {
                ...stage,
                instruction: [stage.instruction, selection.replies].filter(Boolean).join('\n\n')
              }
            : stage,
          upNextAnchorNodeFor(view, stage, minted)
        )
        const own = authored.nodes.filter((node) => node.kind !== 'finish' && !before.has(node.id))
        if (own.length) {
          minted.set(stage.id, own.at(-1)!.id)
        }
      }
      if (person) {
        authored = upNextPlanWithPeople(authored, upNextFinishWith(person))
      }
      // A send always carries the full conversation; only the host can say where it is read.
      const transcriptSource = person
        ? ctx.runtime.getSessionOutcomeTranscriptSource(base)
        : undefined
      await upNextCommitPlan(plan, authored, 'Queued from Up next.', {
        // Queueing behind what is already there ADDS to the plan; it never re-plans it, which
        // is what lets a second + Agent land behind a stage that is queued or running.
        ...(chain ? { mode: 'append' as const } : {}),
        // This commit carries a Person block, so it is an ASK: a review of somebody who has
        // already answered is a second ask and gets its own step and its own gate.
        ...(person ? { asksPeopleAgain: true as const } : {}),
        ...(transcriptSource ? { transcriptSource } : {})
      })
    }
    if (done) {
      const result = await upNextCommitFinish(ctx, done)
      if (result.performed === 'surface') {
        finish = result.finish
      }
    }
  }
  // Exactly the blocks THIS commit queued: a prompt held behind a review is attached when
  // its own stage is, never dropped because the view calls it `waiting` rather than a draft.
  await upNextAttachStagePrompts(ctx, drafts)
  for (const block of drafts) {
    if (block.kind === 'prompt' && block.target.kind !== 'stage') {
      await commitPrompt(ctx, block as UpNextPromptBlock)
    }
  }
  // Which review the held blocks wait on: the one this commit asked for, or the one that was
  // already out. Never simply the chain's last handoff — that can be an answered request.
  const gateBlock = gate === -1 ? undefined : view.blocks[gate]
  const gateStep =
    gateBlock?.kind === 'person'
      ? isUpNextDraftBlockId(gateBlock.id)
        ? upNextReviewStepFor(upNextChainFor(ctx.runtime, ctx.rowKey), gateBlock)
        : gateBlock.stepId
      : undefined
  return {
    committed: drafts.map((block: UpNextBlock) => block.id),
    heldAfter: heldAfter.map((block) => block.id),
    ...(heldAfter.length && gateStep ? { reviewStepId: gateStep } : {}),
    ...(finish ? { finish } : {})
  }
}
