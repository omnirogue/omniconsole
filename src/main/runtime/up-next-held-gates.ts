/**
 * The person reviews that hold a run open, and what the host last learned trying to move it on.
 *
 * A ticked Review ("Wait for their OK") is a gate on its run until every named person approved
 * the current work, whether or not anything waits behind it. The draft store records held work
 * by the review step it waits on (`held.reviewStepId`, written by `upNextDraftsAfterCommit`).
 * Either way the step is a step of exactly one run of this conversation, and that run is not
 * over while the gate is open: the terminal writer reads this to keep it open
 * (`session-outcome-completion.ts`), the tick hands a reviewer's "needs changes" to the agent
 * (`up-next-review-fix.ts`), and the pre-tick releases held work into it (`up-next-continuation.ts`).
 */

import type { SessionChain } from '../../shared/session-chain-types'
import { sessionFollowUpDisposition } from '../../shared/session-follow-up-rule'
import { SESSION_RUN_CONTINUATION_REFUSAL_MAX_CHARS } from '../../shared/session-run-held-continuation'
import type { OrcaRuntimeService } from './omni-runtime'
import { upNextReviewOpen } from './up-next-person-facts'

/** What holds a run: the review steps that gate it, and the last refusal moving one on. */
export type UpNextHeldContinuation = {
  reviewStepIds: string[]
  refused?: string
  /** When the refusal first appeared; kept while it continues. */
  refusedSince?: number
}

type DraftReader = Pick<OrcaRuntimeService, 'readUpNextDrafts'>

/** The schema's own bound: a set may name at most this many gates. */
const MAX_GATES = 20

/**
 * The run whose REVIEW this is: the newest live-or-finished run of the conversation carrying
 * the step as a person review. A Hand off is terminal — nothing is ever held behind one — and a
 * cancelled or unreadable run is nobody's to continue.
 */
export function upNextGateOwner(
  chains: readonly SessionChain[],
  rowKey: string,
  stepId: string
): SessionChain | null {
  return chains
    .filter(
      (chain) =>
        chain.sourceRowKey === rowKey &&
        chain.outcomeSet &&
        !chain.quarantine &&
        chain.state !== 'cancelled' &&
        chain.steps.some(
          (step) =>
            step.id === stepId &&
            step.kind === 'handoff' &&
            sessionFollowUpDisposition(step.handoff) === 'feedback'
        )
    )
    .reduce<SessionChain | null>(
      (newest, chain) => (!newest || chain.createdAt > newest.createdAt ? chain : newest),
      null
    )
}

/**
 * Whether the plan version the review was asked in still has work queued beside it: that work
 * runs before anything held behind the review, and before the agent is handed the reviewer's notes.
 */
export function upNextUnfinishedBesideReview(chain: SessionChain): boolean {
  const version = chain.planVersion ?? 1
  const completed = chain.outcomeSet?.completedSteps ?? []
  return chain.steps.some(
    (step) =>
      step.kind !== 'handoff' &&
      (step.planVersion ?? 1) === version &&
      step.status !== 'skipped' &&
      !completed.includes(step.id)
  )
}

// Why in memory: a refusal is the host's own last attempt, re-read every tick; a restart retries
// within a tick and says why again. Keyed by runtime so two hosts in one process never share one.
const refusals = new WeakMap<object, Map<string, { reason: string; since: number }>>()
const refusalKey = (chainId: string, stepId: string): string => `${chainId}\n${stepId}`

/**
 * The host's attempt was refused. `since` is when the refusal FIRST appeared and is kept while it
 * continues, whatever it says now, so the stale rule measures the refusal and not the wait before it.
 */
export function recordUpNextContinuationRefusal(
  runtime: object,
  chainId: string,
  stepId: string,
  reason: string,
  now = Date.now()
): void {
  const text = reason.trim().slice(0, SESSION_RUN_CONTINUATION_REFUSAL_MAX_CHARS).trim()
  const own = refusals.get(runtime) ?? new Map<string, { reason: string; since: number }>()
  refusals.set(runtime, own)
  const key = refusalKey(chainId, stepId)
  own.set(key, {
    reason: text || 'The continuation could not be committed.',
    since: own.get(key)?.since ?? now
  })
}

export function clearUpNextContinuationRefusal(
  runtime: object,
  chainId: string,
  stepId: string
): void {
  refusals.get(runtime)?.delete(refusalKey(chainId, stepId))
}

/**
 * This run's person reviews of its current plan that are still out. Each one gates the run with
 * nothing held behind it too: only an OK from every named person finishes it. A sealed run is
 * final — one an older build sealed on a "needs changes" reply stays as it is.
 *
 * A card-bound (workflow) run and a planning-source run are not gated this way: their tick
 * returns before it hands a reviewer's notes to the agent (`session-outcome-tick.ts`), so a gate
 * there would hold the run until it failed with the notes never delivered. They seal on the
 * reply as before until they drive fixes; work held behind their reviews still holds them.
 */
function upNextOpenReviewSteps(chain: SessionChain): string[] {
  const set = chain.outcomeSet
  if (set?.completion || set?.workflow || set?.continuation.planningSource) {
    return []
  }
  const version = chain.planVersion ?? 1
  return chain.steps.flatMap((step) =>
    step.kind === 'handoff' &&
    (step.planVersion ?? 1) === version &&
    upNextReviewOpen(chain, step.id)
      ? [step.id]
      : []
  )
}

/**
 * The gates `chain` is held by: its own review steps still out, and those that held work in the
 * draft store waits behind, read with the chain as it is being WRITTEN (it may carry steps the
 * store has not seen). Whose review a gate is — never a Hand off — is `upNextGateOwner`'s alone.
 */
export function upNextHeldContinuation(
  runtime: DraftReader,
  chain: SessionChain,
  chains: readonly SessionChain[]
): UpNextHeldContinuation | null {
  const rowKey = chain.sourceRowKey
  if (!rowKey) {
    return null
  }
  // A host with no draft store holds no work behind a review; it is not an error to have none.
  const entries = runtime.readUpNextDrafts?.(rowKey)?.entries ?? []
  const written = [...chains.filter((entry) => entry.id !== chain.id), chain]
  const gates = [
    ...new Set([
      ...entries.flatMap((entry) => (entry.held ? [entry.held.reviewStepId] : [])),
      ...upNextOpenReviewSteps(chain)
    ])
  ].filter((stepId) => upNextGateOwner(written, rowKey, stepId)?.id === chain.id)
  if (!gates.length) {
    return null
  }
  const own = refusals.get(runtime)
  const refused = gates.map((stepId) => own?.get(refusalKey(chain.id, stepId))).find(Boolean)
  return {
    reviewStepIds: gates.slice(0, MAX_GATES),
    ...(refused ? { refused: refused.reason, refusedSince: refused.since } : {})
  }
}
