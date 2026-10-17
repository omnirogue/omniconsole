/**
 * One conversation's Up next view, assembled from what is already true.
 *
 * Pure: everything it needs is handed to it — the chain, the prompt queue, and ONE
 * reading of whether the conversation's own agent is busy (the same reading the prompt
 * queue drains on, `conversation-readiness.ts`). That keeps the whole projection
 * testable without a host, and keeps "the terminal is idle" meaning one thing.
 */

import type { PromptQueue } from '../../shared/prompt-queue-types'
import { isSessionChainAgentStep, type SessionChain } from '../../shared/session-chain-types'
import { upNextCanAdd, upNextNumber, upNextTargetOf } from '../../shared/up-next-order'
import { upNextSendWaits } from '../../shared/up-next-person-send'
import { upNextNotation, upNextSummary } from '../../shared/up-next-summary'
import {
  upNextDraftStageId,
  upNextIsFinished,
  upNextIsStoppedStage,
  type UpNextAgentBlock,
  type UpNextBlock,
  type UpNextConversationId,
  type UpNextHeader,
  type UpNextNow,
  type UpNextView
} from '../../shared/up-next-types'
import { upNextRunHeader } from './up-next-run-header'
import { upNextChainBlocks, upNextPromptBlocks } from './up-next-blocks'
import { upNextWithDrafts } from './up-next-draft-blocks'
import { upNextPersonWaiting, upNextReviewSettled } from './up-next-person-facts'
import type { UpNextDraftEntry } from '../../shared/up-next-draft-schema'

export type UpNextProjectionInput = {
  conversationId: UpNextConversationId
  rowKey: string
  chain: SessionChain | null
  queue: PromptQueue | null
  /** True while the conversation's own agent is working, or cannot be read. */
  busy: boolean
  /** The agent program running this conversation's pane, when the host names it. */
  agent?: string
  /** What that agent is working on, when the host knows it. One line, never guessed. */
  activity?: string
  /** When the work running now started, when the host can say. Never the read time. */
  busySince?: number
  /** Blocks composed but not queued yet, in the order the person put them. */
  drafts: readonly UpNextDraftEntry[]
  /** Whether this host can read the conversation for a send; absent when none is composed. */
  sendsConversation?: boolean
  now: number
}

/**
 * Composed blocks the plan ALREADY carries, dropped from the composer.
 *
 * A commit is two writes — the plan, then what became of the drafts — and a crash or a failed
 * flush between them leaves executed work in the draft store (`up-next-write.ts`). The chain
 * is the authority: a stage whose seats are on it has been queued, whatever the draft store
 * still says, so it is not also offered as something waiting to be queued. `+ Agent` cannot
 * re-queue it either — the plan refuses a duplicate node id — so the row could only ever be
 * discarded. The host clears it from disk on the next tick (`up-next-continuation.ts`).
 */
function composed(input: UpNextProjectionInput): readonly UpNextDraftEntry[] {
  const stages = new Set(
    (input.chain?.steps ?? [])
      .filter(isSessionChainAgentStep)
      .flatMap((step) => (step.stage?.id ? [step.stage.id] : []))
  )
  return stages.size
    ? input.drafts.filter((entry) => !stages.has(upNextDraftStageId(entry.id)))
    : input.drafts
}

/**
 * Every prompt's target, read from where it sits: the nearest stage above it, the current
 * agent when it resumes after a review, or the conversation's own agent. A prompt already
 * held BY a stage keeps the target it was attached to.
 */
function targeted(blocks: readonly UpNextBlock[]): UpNextBlock[] {
  return blocks.map((block, index) =>
    block.kind === 'prompt' && !block.id.startsWith('sp:')
      ? { ...block, target: upNextTargetOf(blocks, index) }
      : block
  )
}

/** Numbers every block and folds each prompt's count into the block it targets. */
function numbered(blocks: readonly UpNextBlock[]): UpNextBlock[] {
  const { numbers, parentIds } = upNextNumber(blocks)
  const prompts = new Map<string, number>()
  parentIds.forEach((parentId, index) => {
    if (parentId && blocks[index]!.kind === 'prompt') {
      prompts.set(parentId, (prompts.get(parentId) ?? 0) + 1)
    }
  })
  return blocks.map((block, index) => {
    const parentId = parentIds[index]
    return {
      ...block,
      number: numbers[index] ?? '',
      ...(parentId ? { parentId } : {}),
      ...(block.kind === 'agent' ? { promptCount: prompts.get(block.id) ?? 0 } : {})
    }
  })
}

/**
 * Done When entries with a receipt at their outcome's CURRENT revision — k of n, over EVERY
 * outcome of the set. The renderer's head counts the same conditions (`done-when-facts.ts`), so
 * "0 of 2" means two conditions on both sides, never two stages on one and one outcome's on the other.
 */
function doneWhen(chain: SessionChain | null): { met: number; total: number } | undefined {
  const outcomes = chain?.outcomeSet?.outcomes ?? []
  if (!outcomes.length) {
    return undefined
  }
  const met = outcomes.flatMap((outcome) =>
    outcome.conditions.filter((condition) =>
      outcome.evidence.some(
        (receipt) =>
          receipt.conditionId === condition.id && receipt.outcomeRevision === outcome.revision
      )
    )
  )
  return {
    met: met.length,
    total: outcomes.reduce((total, outcome) => total + outcome.conditions.length, 0)
  }
}

/**
 * What a person review is waiting for, and where the track picks up again: the facts come
 * from the outcome's own per-recipient conditions, never from "we sent it, so they replied".
 */
function resumePoints(input: UpNextProjectionInput, blocks: readonly UpNextBlock[]): UpNextBlock[] {
  return blocks.map((block, index) => {
    // A send nobody has ticked yet waits by its default, so it resumes like a review too.
    if (block.kind !== 'person' || !upNextSendWaits(blocks, index)) {
      return block
    }
    const next = blocks.slice(index + 1).find((entry) => entry.kind !== 'prompt')
    const waiting = upNextPersonWaiting(input.chain, block, input.now)
    // Everyone said OK: the review is done, and what was held behind it is the work now.
    const answered = Boolean(block.stepId && upNextReviewSettled(input.chain, block.stepId))
    return {
      ...block,
      waitRule: 'all' as const,
      ...(next ? { resumesAtBlockId: next.id } : {}),
      ...(answered ? { state: 'done' as const, locked: true } : waiting ? { waiting } : {})
    }
  })
}

/** The stage that IS the Now row: the one running, or the one the track stopped at. */
function liveStage(blocks: readonly UpNextBlock[]): UpNextAgentBlock | undefined {
  return blocks.find(
    (block): block is UpNextAgentBlock =>
      block.kind === 'agent' && (block.state === 'running' || upNextIsStoppedStage(block))
  )
}

/** Who a delivered review is still out with, when the policy itself registers no stop. */
function reviewersAwaited(blocks: readonly UpNextBlock[]): string | undefined {
  const review = blocks.find(
    (block) =>
      block.kind === 'person' && block.relationship === 'review' && block.state === 'waiting'
  )
  return review?.kind === 'person'
    ? review.people.map((person) => person.name).join(', ') || undefined
    : undefined
}

/**
 * The header is the run's phase, read from the ONE policy (`up-next-run-header.ts`). Only an
 * `active` run is refined here, by what is in flight: a stage or the conversation's own agent
 * working, a review out with named people, or nothing at all.
 */
function header(
  input: UpNextProjectionInput,
  blocks: readonly UpNextBlock[],
  topLevel: number
): UpNextHeader {
  const stage = liveStage(blocks)
  const at = stage ? { stage: { n: Number(stage.number.split('.')[0] ?? 0), of: topLevel } } : {}
  const run = input.chain ? upNextRunHeader(input.chain, input.now) : null
  if (run) {
    return upNextIsFinished(run.state) ? run : { ...run, ...at }
  }
  if (stage?.state === 'running' || input.busy) {
    return { state: 'running', ...at }
  }
  const wake = reviewersAwaited(blocks)
  return wake ? { state: 'waiting', wake, ...at } : { state: 'idle', ...at }
}

function nowRow(
  input: UpNextProjectionInput,
  blocks: readonly UpNextBlock[],
  state: UpNextHeader
): UpNextNow {
  if (state.state === 'closed') {
    return { kind: 'closed', at: state.closedAt ?? input.now }
  }
  if (state.state === 'completed') {
    return { kind: 'completed', at: state.completedAt ?? input.now }
  }
  const stage = liveStage(blocks)
  if (stage) {
    return { kind: 'stage', blockId: stage.id }
  }
  if (!input.busy) {
    // Idle is a fact about an AGENT: the mockup's row reads "Claude Code · waiting for you",
    // so the name goes with it when the host has one — and is left out when it has not.
    return { kind: 'idle', ...(input.agent ? { agent: input.agent } : {}) }
  }
  // Agent · what it is doing · elapsed (v3 amendment 1), each from the host's own
  // reading: the pane's agent, the prompt its turn is running, and the moment that
  // turn started. A field the host cannot answer stays empty rather than guessed,
  // and an elapsed that would run backwards is not reported at all.
  return {
    kind: 'current-work',
    agent: input.agent ?? '',
    label: input.activity ?? '',
    ...(input.busySince !== undefined && input.busySince <= input.now
      ? { elapsedMs: input.now - input.busySince }
      : {})
  }
}

export function projectUpNext(input: UpNextProjectionInput): UpNextView {
  const blocks = numbered(
    targeted(
      resumePoints(
        input,
        upNextWithDrafts(
          [...upNextPromptBlocks(input.queue), ...upNextChainBlocks(input.chain, input.now)],
          composed(input)
        )
      )
    )
  )
  const { topLevel } = upNextNumber(blocks)
  const head = header(input, blocks, topLevel)
  const now = nowRow(input, blocks, head)
  const met = doneWhen(input.chain)
  const facts = { blocks, header: head, now, ...(met ? { doneWhen: met } : {}) }
  return {
    conversationId: input.conversationId,
    rowKey: input.rowKey,
    header: head,
    now,
    blocks,
    notation: upNextNotation(facts),
    summary: upNextSummary(facts),
    // A finished run takes nothing more whether or not its session was also closed.
    canAdd: upNextCanAdd(blocks, upNextIsFinished(head.state) ? 'closed' : head.state),
    draftCount: blocks.filter((block) => block.state === 'draft').length,
    // A finished run has no queue: a stage it never reached will not run, so it is not counted.
    queuedCount: upNextIsFinished(head.state)
      ? 0
      : blocks.filter((block) => block.state === 'queued').length,
    ...(input.sendsConversation === undefined ? {} : { sendsConversation: input.sendsConversation })
  }
}
