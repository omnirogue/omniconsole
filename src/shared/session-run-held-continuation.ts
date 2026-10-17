import { z } from 'zod'
import { effectiveSessionOutcomeBlock } from './session-outcome-block'

/**
 * A person Review of THIS run that holds it: one not every named person approved yet, or one the
 * person queued work behind (`docs/reference/session-run-lifecycle.md`).
 *
 * The host derives it (`up-next-held-gates.ts`); the single terminal writer stamps that
 * reading on the set for as long as it holds, so every reader — the renderer included — sees one
 * phase and none derives it again. It lives on the set, not as a block on an outcome, because the
 * outcome it waits behind is often already proven, and a satisfied outcome carries no block.
 *
 * The held work is released only when every named reviewer approved the current version. A reply
 * that asks for changes is acted on exactly once: its notes go to this conversation's own agent, and
 * when that turn ends every reviewer of the round is asked again on the new version. `fixes` is the
 * record of that, per reply; `superseded` is every answer the new version retired.
 */
export const SESSION_RUN_CONTINUATION_CODES = {
  /** Everyone approved, and the host has not started the held work. */
  held: 'continuation-held',
  /** The host tried to move the held work on (start it, or hand the notes over) and was refused. */
  refused: 'continuation-refused',
  /** The notes' send has an unknown result, so they are never sent twice. */
  fixFailed: 'review-fix-failed'
} as const

export const SESSION_RUN_CONTINUATION_REFUSAL_MAX_CHARS = 1_000
export const SESSION_RUN_REVIEW_NOTE_MAX_CHARS = 4_000

const id = z.string().min(1).max(200)
const at = z.number().finite().nonnegative()
const diagnostic = z.string().trim().min(1).max(SESSION_RUN_CONTINUATION_REFUSAL_MAX_CHARS)

/** One "needs changes" reply, and what the run has done about it. Keyed by its receipt. */
export const sessionRunReviewFixSchema = z
  .object({
    /** The review receipt this answers (`handoff-review:<thread>:<review>:request_changes`). */
    receipt: z.string().min(1).max(1_000),
    stepId: id,
    employeeId: id,
    /** The reviewer's round when they asked for changes. */
    round: z.number().int().positive(),
    note: z.string().trim().min(1).max(SESSION_RUN_REVIEW_NOTE_MAX_CHARS).optional(),
    /** When the reply was recorded. */
    at,
    /**
     * The prompt-queue entry that carries the notes to this conversation's agent. A send refused
     * before any byte moved names a new one, so the next pass sends again under it.
     */
    promptId: id.optional(),
    /** The finished turn the notes were sent after: the NEXT ending is the fix finishing. */
    turnVersion: z.string().min(1).max(500).optional(),
    deliveredAt: at.optional(),
    /** The fix turn ended and the reviewer was asked again. */
    reaskedAt: at.optional(),
    /**
     * Why the notes may or may not have reached the agent (the result is unknown), so they are
     * never sent again. A send proven to have moved nothing is a refusal instead, and retried.
     */
    failed: diagnostic.optional()
  })
  .strict()
export type SessionRunReviewFix = z.infer<typeof sessionRunReviewFixSchema>

export const SESSION_RUN_SUPERSEDED_MAX = 128

export const sessionRunHeldContinuationSchema = z
  .object({
    /** The review steps of this run that hold it: still out, or with work waiting behind them. */
    reviewStepIds: z.array(id).min(1).max(20),
    /** When the run was otherwise complete: the stale rule is measured from here. */
    since: at.optional(),
    /** Why the host's last attempt to move the held work on was refused. A diagnostic. */
    refused: diagnostic.optional(),
    /** When that refusal first appeared; a refused run's stale rule is measured from here. */
    refusedSince: at.optional(),
    fixes: z.array(sessionRunReviewFixSchema).max(64).optional(),
    /**
     * Answers to a version the work no longer is: a re-ask after a fix retired them (approvals
     * included), so no reading and no verifier counts one again. Review receipts, newest last.
     */
    superseded: z.array(z.string().min(1).max(1_000)).max(SESSION_RUN_SUPERSEDED_MAX).optional()
  })
  .strict()
export type SessionRunHeldContinuation = z.infer<typeof sessionRunHeldContinuationSchema>

export type SessionReviewDecision = 'approve' | 'request_changes'

const REVIEW_RECEIPT =
  /^handoff-review:(hth_[A-Za-z0-9_-]{1,128}):([^:]{1,200}):(approve|request_changes)$/

/** The hub reply a review receipt counted, as the verifier writes it; null for any other receipt. */
export function sessionReviewReceiptReply(
  receipt: string
): { threadId: string; reviewId: string; decision: SessionReviewDecision } | null {
  const match = REVIEW_RECEIPT.exec(receipt)
  return match
    ? { threadId: match[1]!, reviewId: match[2]!, decision: match[3] as SessionReviewDecision }
    : null
}

/** Only a reply that says so asks for changes; any other answer the host counted is an OK. */
export function sessionReviewDecision(receipt: string): SessionReviewDecision {
  return sessionReviewReceiptReply(receipt)?.decision ?? 'approve'
}

/**
 * Review receipts that answer nothing now: a reply whose notes were fixed and whose reviewer was
 * asked again, and every answer a re-ask retired. The panel reading and the verifier share it.
 */
export function spentSessionReviewReceipts(
  hold: SessionRunHeldContinuation | undefined
): Set<string> {
  return new Set([
    ...(hold?.fixes ?? []).filter((fix) => fix.reaskedAt !== undefined).map((fix) => fix.receipt),
    ...(hold?.superseded ?? [])
  ])
}

/** Fixes whose reviewer has not been asked again yet. */
export function openSessionReviewFixes(
  hold: SessionRunHeldContinuation | undefined
): SessionRunReviewFix[] {
  return (hold?.fixes ?? []).filter((fix) => fix.reaskedAt === undefined)
}

/** The notes are with this conversation's agent and its turn has not ended. */
export function sessionReviewFixRunning(hold: SessionRunHeldContinuation | undefined): boolean {
  return openSessionReviewFixes(hold).some((fix) => fix.deliveredAt !== undefined && !fix.failed)
}

export type SessionRunHeldContinuationReading =
  | { phase: 'active' }
  | { phase: 'recovering' | 'failed'; code: string; reason?: string }

/**
 * What held work makes of a run that is otherwise done. The host moves it on by itself — the
 * notes to the agent, or the released work — so it is `active`; a refused attempt is `recovering`
 * while the host retries it; either one still standing after the recovering maximum is an honest
 * `failed`. Never `needs-you`, and never `completed`.
 */
export function readSessionRunHeldContinuation(
  hold: SessionRunHeldContinuation,
  now: number
): SessionRunHeldContinuationReading {
  const open = openSessionReviewFixes(hold)
  const broken = open.find((fix) => fix.failed)
  if (broken) {
    return {
      phase: 'failed',
      code: SESSION_RUN_CONTINUATION_CODES.fixFailed,
      reason: broken.failed
    }
  }
  // Why no stale rule here: the agent is fixing the work, or its conversation is busy with a turn.
  if (open.length && !hold.refused) {
    return { phase: 'active' }
  }
  const code = hold.refused
    ? SESSION_RUN_CONTINUATION_CODES.refused
    : SESSION_RUN_CONTINUATION_CODES.held
  // Why the refusal's own start: a refusal at the end of a long fix turn is new, not stale.
  const since = (hold.refused ? hold.refusedSince : undefined) ?? hold.since ?? now
  // The same stale rule every recovering block is read by, so held work cannot wait silently.
  const block = effectiveSessionOutcomeBlock(
    { status: 'blocked', block: { class: 'recovering', code, since } },
    now
  )
  if (block?.class === 'failed') {
    return { phase: 'failed', code, ...(hold.refused ? { reason: hold.refused } : {}) }
  }
  return hold.refused ? { phase: 'recovering', code, reason: hold.refused } : { phase: 'active' }
}
