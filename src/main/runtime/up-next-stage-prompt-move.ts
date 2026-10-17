/**
 * Where a stage's prompts SIT, and what the person changes when they move or remove one.
 *
 * A prompt written under an Agent block is one instruction for the whole stage: the commit
 * fans it out to every seat, and the panel shows the stage's FIRST seat as the row
 * (`up-next-blocks.ts`). So a move or a removal is a change to the STAGE, not to that one
 * copy — it lands on every seat holding it, in ONE chain write, or the other seats deliver
 * an order the panel stopped showing and a withdrawn prompt still arrives.
 *
 * The copies share their id: one prompt, one identity, however many seats hold it
 * (`up-next-stage-prompts.ts`). On a chain written before that — every copy with an id of its
 * own — only the seat the row names can be addressed, so the peers are left exactly as they
 * are rather than reordered by a guess about which copy is which.
 */

import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep
} from '../../shared/session-chain-types'
import { UP_NEXT_BLOCK_ID, UP_NEXT_REFUSAL_KEYS } from '../../shared/up-next-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { upNextChainFor } from './up-next'

type StagePromptContext = { runtime: OrcaRuntimeService; rowKey: string }

type NamedStage = {
  chain: SessionChain
  /** The seat the row was read from: the one whose prompt ids the block id carries. */
  seat: SessionChainAgentStep
  /** Every seat of that stage, this one included — each holding its own copy. */
  seats: SessionChainAgentStep[]
  promptId: string
}

/** The stage one `sp:` row names, or null when nothing on this chain answers to it. */
function namedStage(ctx: StagePromptContext, blockId: string): NamedStage | null {
  const [stepId, promptId] = blockId.slice(UP_NEXT_BLOCK_ID.stagePrompt.length).split(':')
  const chain = upNextChainFor(ctx.runtime, ctx.rowKey)
  const agents = chain?.steps.filter(isSessionChainAgentStep) ?? []
  const seat = agents.find((step) => step.id === stepId)
  if (!chain?.outcomeSet || !seat || !promptId) {
    return null
  }
  // The same grouping the fan-out wrote to (`upNextStageSeats`): the shape's own stage id,
  // or the plan node when a lone seat carries no stage.
  const stage = seat.stage?.id
  const seats = stage
    ? agents.filter((step) => step.stage?.id === stage)
    : agents.filter((step) => (step.planNodeId ?? step.id) === (seat.planNodeId ?? seat.id))
  return { chain, seat, seats, promptId }
}

/** One write for every seat whose prompts changed, through the outcome revision CAS. */
function writeStagePrompts(
  ctx: StagePromptContext,
  chain: SessionChain,
  next: ReadonlyMap<string, PromptQueueEntry[]>
): void {
  if (!next.size || !chain.outcomeSet) {
    return
  }
  ctx.runtime.getSessionOutcomeService().save(
    {
      ...chain,
      steps: chain.steps.map((step) =>
        isSessionChainAgentStep(step) && next.has(step.id)
          ? { ...step, prompts: next.get(step.id)! }
          : step
      )
    },
    chain.outcomeSet.revision
  )
}

/** This seat's own copy of a prompt, whatever state that seat has taken it to. */
function copyOf(seat: SessionChainAgentStep, promptId: string): PromptQueueEntry | undefined {
  return (seat.prompts ?? []).find((prompt) => prompt.id === promptId)
}

/**
 * Takes one prompt back off a stage — off every seat of it. A delivery already under way is
 * not withdrawable (the bytes may be gone), which is the rule the prompt queue keeps, and a
 * seat that has already sent it keeps its record: that one is history, not a plan.
 */
export function upNextRemoveStagePrompt(ctx: StagePromptContext, blockId: string): void {
  const stage = namedStage(ctx, blockId)
  if (!stage) {
    return
  }
  const next = new Map<string, PromptQueueEntry[]>()
  for (const seat of stage.seats) {
    const copy = copyOf(seat, stage.promptId)
    if (!copy || copy.state === 'sending' || copy.state === 'delivered') {
      continue
    }
    next.set(
      seat.id,
      (seat.prompts ?? []).filter((prompt) => prompt.id !== stage.promptId)
    )
  }
  writeStagePrompts(ctx, stage.chain, next)
}

/**
 * Moves one waiting prompt one place inside its own stage, in every seat of it.
 *
 * The rows the person is looking at are the prompts that have NOT been delivered — a
 * delivered one is in the transcript, not in Up next — so the swap is among those. The
 * neighbour is named by the caller from the view: anything but this stage's own next row is
 * outside the stage, and there is nowhere for the prompt to go.
 */
export function upNextReorderStagePrompt(
  ctx: StagePromptContext,
  blockId: string,
  neighbourBlockId: string,
  direction: -1 | 1
): void {
  const stage = namedStage(ctx, blockId)
  if (!stage || !neighbourBlockId.startsWith(`${UP_NEXT_BLOCK_ID.stagePrompt}${stage.seat.id}:`)) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
  }
  const shown = (stage.seat.prompts ?? []).filter((prompt) => prompt.state !== 'delivered')
  const at = shown.findIndex((prompt) => prompt.id === stage.promptId)
  const moved = shown[at]
  const target = shown[at + direction]
  if (!moved || !target) {
    throw new Error(UP_NEXT_REFUSAL_KEYS.pastTerminal)
  }
  const next = new Map<string, PromptQueueEntry[]>()
  for (const seat of stage.seats) {
    const here = [copyOf(seat, moved.id), copyOf(seat, target.id)]
    const [first, second] = here
    if (!first || !second) {
      continue
    }
    // A delivery in flight can be neither moved nor overtaken — in ANY seat, because the row
    // moves for the whole stage at once. Refused before a single seat is written.
    if (here.some((prompt) => prompt?.state === 'sending')) {
      throw new Error(UP_NEXT_REFUSAL_KEYS.blockRunning)
    }
    const swapped = new Map([
      [first.id, second],
      [second.id, first]
    ])
    next.set(
      seat.id,
      (seat.prompts ?? []).map((prompt) => swapped.get(prompt.id) ?? prompt)
    )
  }
  writeStagePrompts(ctx, stage.chain, next)
}
