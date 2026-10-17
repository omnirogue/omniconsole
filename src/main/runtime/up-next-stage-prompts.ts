/**
 * Prompts that belong to a STAGE, not to the conversation.
 *
 * A prompt added under an agent block is not a message to the person's own agent: it is an
 * extra instruction for that stage, and it is delivered into the seat's OWN conversation —
 * the same door the prompt queue uses (`deliverToConversation`) — once that seat is idle,
 * in the order the person wrote them. The receipt lands on the step before the bytes move,
 * so a restart can tell "already sent" from "never sent" and never sends one twice.
 *
 * A seat that has not launched holds its prompts; a seat that never launches never sends
 * them. Nothing here starts a step, and nothing here touches the outcome set. Moving and
 * removing one of these rows is the stage's whole order, so it lives beside this file
 * (`up-next-stage-prompt-move.ts`).
 */

import { randomUUID } from 'node:crypto'
import { conversationDeliveryOperationId } from '../../shared/conversation-source'
import {
  isPromptQueueEntrySettled,
  nextPromptQueueEntry,
  type PromptQueueEntry
} from '../../shared/prompt-queue-types'
import {
  isSessionChainAgentStep,
  type SessionChain,
  type SessionChainAgentStep,
  type SessionChainStep
} from '../../shared/session-chain-types'
import { UP_NEXT_BLOCK_ID, upNextDraftStageId, type UpNextBlock } from '../../shared/up-next-types'
import { observeConversationReadiness } from './conversation-readiness'
import { deliverToConversation } from './conversation-delivery'
import type { OrcaRuntimeService } from './omni-runtime'
import { upNextChainFor } from './up-next'
import { upNextSeatConversation } from './up-next-stage-seat'

/** Every seat of the stage a block names: a prompt to a stage is a prompt to all of it. */
export function upNextStageSeats(
  chain: SessionChain,
  blockId: string,
  draftStageId?: string
): SessionChainAgentStep[] {
  const agents = chain.steps.filter(isSessionChainAgentStep)
  if (draftStageId) {
    const seats = agents.filter((step) => step.stage?.id === draftStageId)
    if (seats.length) {
      return seats
    }
  }
  const node = blockId.startsWith(UP_NEXT_BLOCK_ID.planNode)
    ? blockId.slice(UP_NEXT_BLOCK_ID.planNode.length)
    : null
  if (!node) {
    return []
  }
  const named = agents.filter((step) => (step.planNodeId ?? step.id) === node)
  const stage = named[0]?.stage?.id
  return stage ? agents.filter((step) => step.stage?.id === stage) : named
}

function entry(text: string): PromptQueueEntry {
  return {
    id: `stage-${randomUUID()}`,
    text,
    createdAt: Date.now(),
    state: 'queued'
  }
}

/**
 * Changes ONE seat's prompts, and nothing else.
 *
 * Every write starts from a fresh read and is applied to that record, so a tick that wrote
 * an attempt or a wait between the read and the write is never rolled back. `expect` is the
 * state the prompt must still be in for the change to land: two processes cannot both settle
 * one delivery, and a queued prompt cannot be marked sending twice. A refused write returns
 * null and is simply retried on the next pass — there is nothing to repair.
 */
function mutateSeatPrompts(
  runtime: OrcaRuntimeService,
  rowKey: string,
  stepId: string,
  change: (prompts: readonly PromptQueueEntry[]) => PromptQueueEntry[],
  expect?: { promptId: string; state: PromptQueueEntry['state']; epoch?: string }
): SessionChain | null {
  const fresh = upNextChainFor(runtime, rowKey)
  const seat = fresh?.steps.find((step) => step.id === stepId)
  if (!fresh?.outcomeSet || !seat || !isSessionChainAgentStep(seat)) {
    return null
  }
  if (expect) {
    const prompt = (seat.prompts ?? []).find((entry) => entry.id === expect.promptId)
    if (
      prompt?.state !== expect.state ||
      (expect.epoch !== undefined && prompt.deliveryEpoch !== expect.epoch)
    ) {
      return null
    }
  }
  return runtime.getSessionOutcomeService().save(
    {
      ...fresh,
      steps: fresh.steps.map((step) =>
        isSessionChainAgentStep(step) && step.id === stepId
          ? { ...step, prompts: change(step.prompts ?? []) }
          : step
      )
    },
    fresh.outcomeSet.revision
  )
}

/**
 * Attaches the prompts that target a stage to that stage's seats. Called by the commit with
 * the blocks THAT commit queued, AFTER the plan is committed, so the seats it names exist.
 *
 * The blocks are the commit's own, not the whole view: a prompt a review is holding reads as
 * `waiting` rather than `draft`, and filtering on the state here is what used to delete it
 * on resume — the commit counted it as queued while nothing had been attached.
 */
export async function upNextAttachStagePrompts(
  ctx: { runtime: OrcaRuntimeService; rowKey: string },
  blocks: readonly UpNextBlock[]
): Promise<void> {
  const drafts = blocks.filter((block) => block.kind === 'prompt' && block.target.kind === 'stage')
  if (!drafts.length) {
    return
  }
  const chain = upNextChainFor(ctx.runtime, ctx.rowKey)
  if (!chain?.outcomeSet) {
    return
  }
  const additions = new Map<string, PromptQueueEntry[]>()
  for (const block of drafts) {
    if (block.kind !== 'prompt' || block.target.kind !== 'stage') {
      continue
    }
    const target = block.target.blockId
    const seats = upNextStageSeats(chain, target, upNextDraftStageId(target))
    // ONE prompt, one identity, however many seats hold it: the person wrote the instruction
    // once, and moving or withdrawing the row has to reach every copy of it
    // (`up-next-stage-prompt-move.ts`). Ids are read per seat, so sharing one is safe.
    const copy = entry(block.text)
    for (const seat of seats) {
      additions.set(seat.id, [...(additions.get(seat.id) ?? []), { ...copy }])
    }
  }
  // An append is computed from whatever the seat holds NOW, so nothing that arrived in the
  // meantime is dropped and nothing is written twice.
  for (const [stepId, added] of additions) {
    mutateSeatPrompts(ctx.runtime, ctx.rowKey, stepId, (prompts) => [...prompts, ...added])
  }
}

/** A prompt still to send: queued, or a delivery this host must still settle. */
function holdsUnsent(step: SessionChainStep): boolean {
  return (
    isSessionChainAgentStep(step) &&
    (step.prompts ?? []).some((prompt) => !isPromptQueueEntrySettled(prompt))
  )
}

async function drainOneStage(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  step: SessionChainAgentStep,
  epoch: string
): Promise<void> {
  const prompts = step.prompts ?? []
  const stranded = prompts.find(
    (prompt) => prompt.state === 'sending' && prompt.deliveryEpoch !== epoch
  )
  const settle = (
    id: string,
    change: Partial<PromptQueueEntry>,
    expect: { state: PromptQueueEntry['state']; epoch?: string }
  ): boolean =>
    mutateSeatPrompts(
      runtime,
      chain.sourceRowKey,
      step.id,
      (prompts) =>
        prompts.map((prompt) =>
          prompt.id === id ? ({ ...prompt, ...change } as PromptQueueEntry) : prompt
        ),
      { promptId: id, ...expect }
    ) !== null
  if (stranded) {
    settle(
      stranded.id,
      {
        state: 'failed',
        reason:
          'OmniConsole restarted while this prompt was being sent to the stage, so it cannot confirm the agent received it.'
      },
      { state: 'sending', epoch: stranded.deliveryEpoch }
    )
    return
  }
  const conversation = upNextSeatConversation(runtime, chain, step)
  const next = conversation
    ? nextPromptQueueEntry({ source: conversation, entries: prompts })
    : null
  if (!next || !conversation) {
    return
  }
  const readiness = await observeConversationReadiness(runtime, conversation)
  if (!readiness.ready) {
    return
  }
  const operationId = conversationDeliveryOperationId('up-next-stage', randomUUID())
  // Admission is the CAS: whoever marks it `sending` owns the delivery, and a second
  // process that lost the race sends nothing.
  if (
    !settle(next.id, { state: 'sending', operationId, deliveryEpoch: epoch }, { state: 'queued' })
  ) {
    return
  }
  try {
    const delivery = await deliverToConversation(runtime, conversation, next.text, { operationId })
    settle(
      next.id,
      { state: 'delivered', deliveredAt: delivery.deliveredAt, door: delivery.door },
      { state: 'sending', epoch }
    )
  } catch (error) {
    settle(
      next.id,
      { state: 'failed', reason: error instanceof Error ? error.message : String(error) },
      { state: 'sending', epoch }
    )
  }
}

const draining = new Set<string>()

/**
 * Does any chain hold a prompt to deliver? Asked BEFORE the drain is awaited, so a host with
 * no stage prompts — which is every ordinary conversation — takes not one extra turn on the
 * tick: the launch sequence that follows must keep the order it has always had.
 */
export function upNextHoldsStagePrompts(runtime: OrcaRuntimeService): boolean {
  return runtime
    .listSessionChains()
    .some(
      (chain) =>
        chain.outcomeSet && !chain.quarantine && chain.steps.some((step) => holdsUnsent(step))
    )
}

/**
 * One pass over every stage holding prompts: the first waiting prompt of each launched,
 * idle seat is delivered. Runs on the host tick beside the prompt-queue drain.
 */
export async function drainUpNextStagePrompts(
  runtime: OrcaRuntimeService,
  options: { epoch: string }
): Promise<void> {
  for (const chain of runtime.listSessionChains()) {
    if (!chain.outcomeSet || chain.quarantine) {
      continue
    }
    for (const step of chain.steps.filter(isSessionChainAgentStep)) {
      if (!holdsUnsent(step)) {
        continue
      }
      const key = `${chain.id}:${step.id}`
      if (draining.has(key)) {
        continue
      }
      draining.add(key)
      try {
        await drainOneStage(runtime, chain, step, options.epoch)
      } catch (error) {
        console.warn('[up-next] stage prompt delivery failed', key, error)
      } finally {
        draining.delete(key)
      }
    }
  }
}
