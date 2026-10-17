/**
 * What runs after a person review — committed by the HOST, the moment they have replied.
 *
 * Sal's model: "a person review can return to the chain … agents may follow it". So the
 * person composes Review → Improve → Verify in one go. The review is committed with the
 * plan (it is where the work reaches people); everything behind it is HELD, shown in place
 * as waiting, and appended here to the SAME run once every named reviewer has APPROVED the
 * current version — through the same `commitWorkPlan` door, with the same receipts, and with
 * no renderer involved. Until it launches, the person may still move or remove it.
 *
 * The held work belongs to the run whose review it waits on (`up-next-held-gates.ts`), and
 * that run is not over until the work has run: the terminal writer keeps it open, so the
 * append lands in it rather than being refused as a closed run or forked off it. A reply that
 * asks for changes releases nothing: the tick hands its notes to this conversation's agent and
 * asks that reviewer again (`up-next-review-fix.ts`). What the reviewers said rides into the
 * released stages (`up-next-review-brief.ts`), and a release the engine refuses is recorded on
 * the run as a classified state instead of a log line.
 *
 * "They said OK" is counted from RECEIPTS on their own review conditions at the current
 * revision (`up-next-person-facts.ts`), never from the request having been delivered.
 */

import { isSessionChainAgentStep, type SessionChain } from '../../shared/session-chain-types'
import type { UpNextDraftEntry } from '../../shared/up-next-draft-schema'
import { upNextDraftStageId } from '../../shared/up-next-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { isFinishedOutcomeChain } from './session-outcome-source-uniqueness'
import { upNextChainFor, upNextView } from './up-next'
import { upNextCommitDrafts } from './up-next-commit'
import {
  clearUpNextContinuationRefusal,
  recordUpNextContinuationRefusal,
  upNextGateOwner,
  upNextUnfinishedBesideReview
} from './up-next-held-gates'
import { upNextReviewSettled } from './up-next-person-facts'
import { upNextReviewReplyBrief } from './up-next-review-brief'

/** What one commit queued, and what it held behind a review, as `upNextCommitDrafts` answers. */
export type UpNextCommitResult = {
  committed: readonly string[]
  heldAfter: readonly string[]
  reviewStepId?: string
}

/**
 * The draft store as one commit leaves it: what was queued is gone, and what the commit HELD
 * behind a person review is marked with the review it waits on. Shared with the manual commit
 * (`up-next-write.ts`) because the marker is this file's own record — `openGates` reads it back
 * to decide what to resume — and a commit that deleted a held block instead of marking it would
 * drop work nobody ever ran.
 */
export function upNextDraftsAfterCommit(
  entries: readonly UpNextDraftEntry[],
  result: UpNextCommitResult,
  at: number
): UpNextDraftEntry[] {
  const committed = new Set(result.committed)
  const held = new Set(result.heldAfter)
  return entries
    .filter((entry) => !committed.has(entry.id))
    .map((entry) =>
      held.has(entry.id) && result.reviewStepId
        ? { ...entry, held: { reviewStepId: result.reviewStepId, committedAt: at } }
        : entry
    )
}

/**
 * Composed blocks the plan already carries: a commit whose plan flush landed and whose second
 * write — the one that clears what was queued — did not.
 *
 * The two are one flush apart, so a crash or a failed `flushOrThrow` in that second leaves
 * executed work on disk as drafts. Nothing is lost and no order changed, but the entry can
 * only ever be discarded (the plan refuses its duplicate node id), so the host discards it:
 * the read already hides it (`up-next-projection.ts`) and this is where disk catches up.
 */
function upNextStrandedDrafts(runtime: OrcaRuntimeService, rowKey: string): UpNextDraftEntry[] {
  const entries = runtime.readUpNextDrafts(rowKey)?.entries ?? []
  const chain = entries.length ? upNextChainFor(runtime, rowKey) : null
  const stages = new Set(
    (chain?.steps ?? [])
      .filter(isSessionChainAgentStep)
      .flatMap((step) => (step.stage?.id ? [step.stage.id] : []))
  )
  return stages.size ? entries.filter((entry) => stages.has(upNextDraftStageId(entry.id))) : []
}

type OpenGate = { held: string[]; reviewStepId: string; owner: SessionChain }

/**
 * Review steps whose reviewers have all approved, the held blocks waiting on them, and the run
 * each review belongs to — read off that run, whichever run of the conversation is newest.
 */
function openGates(runtime: OrcaRuntimeService, rowKey: string): OpenGate[] {
  const entries = runtime.readUpNextDrafts(rowKey)?.entries ?? []
  const chains = runtime.listSessionChains()
  const gates = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.held) {
      gates.set(entry.held.reviewStepId, [...(gates.get(entry.held.reviewStepId) ?? []), entry.id])
    }
  }
  // The continuation waits for two things: the reviewers, and the work that was queued with
  // them — a stage the person queued beside the review runs before what was held behind it.
  return [...gates].flatMap(([reviewStepId, held]) => {
    const owner = upNextGateOwner(chains, rowKey, reviewStepId)
    return owner?.outcomeSet &&
      !upNextUnfinishedBesideReview(owner) &&
      upNextReviewSettled(owner, reviewStepId)
      ? [{ reviewStepId, held, owner }]
      : []
  })
}

/**
 * Why a gate that is open cannot be committed yet, or undefined. The release continues the run
 * whose review opened it; while ANOTHER run of this conversation is live, committing would append
 * this work to that run and take its people off it, so it waits and says so.
 */
function otherRunInProgress(runtime: OrcaRuntimeService, rowKey: string, owner: SessionChain) {
  const live = upNextChainFor(runtime, rowKey)
  return live && live.id !== owner.id && !isFinishedOutcomeChain(live)
    ? `Another run of this conversation (${live.id}) is in progress. The work queued after the review starts when it has finished.`
    : undefined
}

const running = new Set<string>()

/**
 * Is any conversation holding blocks behind a review? Asked BEFORE the resume is awaited, so
 * a host with none takes not one extra turn on the tick — the launch sequence that follows
 * keeps the order the durable-restart contract reads.
 */
export function upNextHoldsContinuation(runtime: OrcaRuntimeService): boolean {
  return Object.entries(runtime.listUpNextDrafts() ?? {}).some(
    ([rowKey, record]) =>
      record.entries.some((entry) => entry.held) ||
      // The other thing this pass owes the person: clearing what a half-landed commit left
      // behind. Asked only for a conversation that is composing something at all.
      upNextStrandedDrafts(runtime, rowKey).length > 0
  )
}

/**
 * One pass over every conversation holding a continuation. A commit that the plan engine
 * refuses — work still in flight, a stage that no longer validates — leaves the blocks
 * exactly where they are and is asked again on the next tick; nothing is lost and nothing
 * is committed twice, because the entries are cleared in the same call that commits them.
 */
export async function resumeUpNextContinuations(runtime: OrcaRuntimeService): Promise<void> {
  // A host with no draft store holds no continuation; it is not an error to have none.
  for (const [rowKey, record] of Object.entries(runtime.listUpNextDrafts() ?? {})) {
    if (running.has(rowKey)) {
      continue
    }
    const stranded = new Set(upNextStrandedDrafts(runtime, rowKey).map((entry) => entry.id))
    if (stranded.size) {
      try {
        runtime.replaceUpNextDraftsAndFlush(
          record.subject,
          (runtime.readUpNextDrafts(rowKey)?.entries ?? []).filter(
            (entry) => !stranded.has(entry.id)
          )
        )
      } catch (error) {
        // Named, not swallowed: the read already hides these rows, and the next tick retries.
        console.warn('[up-next] queued drafts not cleared yet', rowKey, error)
      }
    }
    if (!(runtime.readUpNextDrafts(rowKey)?.entries ?? []).some((entry) => entry.held)) {
      continue
    }
    for (const { reviewStepId } of openGates(runtime, rowKey)) {
      // Read again per gate: a release earlier in this pass has already moved its run on.
      const gate = openGates(runtime, rowKey).find((entry) => entry.reviewStepId === reviewStepId)
      if (!gate) {
        continue
      }
      running.add(rowKey)
      try {
        const waiting = otherRunInProgress(runtime, rowKey, gate.owner)
        if (waiting) {
          throw new Error(waiting)
        }
        const ctx = { runtime, conversationId: record.subject, rowKey }
        const at = Date.now()
        const replies = await upNextReviewReplyBrief(gate.owner, gate.reviewStepId)
        const view = await upNextView(runtime, record.subject)
        const held = new Set(gate.held)
        const result = await upNextCommitDrafts(ctx, view, {
          only: (block) => held.has(block.id),
          resumed: true,
          run: gate.owner,
          ...(replies ? { replies } : {})
        })
        // A block this commit held again — a second review nested behind the first — is
        // MARKED with its new gate, never deleted: deleting it would throw away work the
        // person composed and nobody has run. Flushed with the plan, not debounced, so a
        // restart in the next second cannot resurrect what just ran or lose what waits.
        runtime.replaceUpNextDraftsAndFlush(
          record.subject,
          upNextDraftsAfterCommit(runtime.readUpNextDrafts(rowKey)?.entries ?? [], result, at)
        )
        clearUpNextContinuationRefusal(runtime, gate.owner.id, gate.reviewStepId)
      } catch (error) {
        // The blocks stay held and the next tick asks again. The refusal is the RUN's state: its
        // next save records it (`session-outcome-completion.ts`), recovering and then failed.
        const reason = error instanceof Error ? error.message : String(error)
        recordUpNextContinuationRefusal(runtime, gate.owner.id, gate.reviewStepId, reason)
        console.warn('[up-next] continuation not queued yet', rowKey, error)
      } finally {
        running.delete(rowKey)
      }
    }
  }
}
