import { parseSessionVerdict } from './session-chain-verdict'
import {
  sessionReviewBlockCause,
  sessionReviewRoundDecision,
  type SessionReviewAssignment,
  type SessionReviewBlockCause,
  type SessionReviewGroupState,
  type SessionReviewLoopState,
  type SessionReviewReceipt,
  type SessionReviewRepairAssignment
} from './session-chain-review'

export type SessionReviewTransition = {
  loop: SessionReviewLoopState
  next: 'finish' | 'launch-repair' | 'block' | 'reask'
  reason?: string
  /** Why the round blocked, as a fact a writer can classify; `reason` is only the diagnostic. */
  cause?: SessionReviewBlockCause
  /** The seats asked again for the verdict they did not return; the round stays `reviewing`. */
  reask?: string[]
}

/** The diagnostic of each block cause. A missing verdict is never worded as a rejection. */
export const SESSION_REVIEW_BLOCK_REASONS: Record<SessionReviewBlockCause, string> = {
  'no-verdict': 'A selected reviewer did not return a valid verdict.',
  'insufficient-evidence':
    'A selected verifier could not judge; supply the evidence it named and verify again.',
  findings: 'Review findings have no authorized repair owner or remain at the round cap.'
}

/** Pure host transition from completed immutable reviewer outputs to the next durable action. */
export function transitionSessionReviewRound(args: {
  loop?: SessionReviewLoopState
  assignment: Omit<SessionReviewAssignment, 'reviewerId'>
  reviewers: readonly {
    stepId: string
    reviewerId: string
    output: string
    crashed?: boolean
    /** The attempt that produced `output`; when known, a bound verdict must name it. */
    attemptId?: string
  }[]
  hasAuthorizedRepair: boolean
  reviewOnly: boolean
  /** Seats the host may still ask again; a missing verdict from any other seat blocks the round. */
  reaskable?: readonly string[]
  now: number
}): SessionReviewTransition {
  const receipts = args.reviewers.map((reviewer): SessionReviewReceipt => {
    const parsed = reviewer.crashed ? null : parseSessionVerdict(reviewer.output)
    // A bound envelope must name this seat and this round's version: a copied or stale one is none.
    const verdict =
      parsed &&
      parsed !== 'ambiguous' &&
      (parsed.marker !== 'verdict' ||
        (parsed.stepId === reviewer.stepId &&
          parsed.candidateVersion === args.assignment.candidateVersion &&
          (!reviewer.attemptId || parsed.attemptId === reviewer.attemptId)))
        ? parsed
        : null
    return {
      stepId: reviewer.stepId,
      reviewerId: reviewer.reviewerId,
      candidateVersion: args.assignment.candidateVersion,
      status: verdict?.status ?? 'crashed',
      blockingFindings: verdict?.blockingFindings ?? [],
      ...(verdict?.notes ? { notes: verdict.notes } : {}),
      recordedAt: args.now
    }
  })
  const decision = sessionReviewRoundDecision({
    expectedReviewerIds: args.reviewers.map((reviewer) => reviewer.reviewerId),
    receipts,
    candidateVersion: args.assignment.candidateVersion,
    round: args.assignment.round,
    maxRounds: args.assignment.maxRounds,
    reviewOnly: args.reviewOnly,
    gate: args.assignment.gate === true
  })
  const previous = args.loop?.groups.find((group) => group.id === args.assignment.groupId)
  const blocked = decision === 'blocked' || (decision === 'repair' && !args.hasAuthorizedRepair)
  const silent = receipts.filter((receipt) => receipt.status === 'crashed')
  // A missing verdict is asked for again before it is anything else: it is not a rejection.
  const reask =
    silent.length > 0 && silent.every((receipt) => args.reaskable?.includes(receipt.stepId))
  const group: SessionReviewGroupState = {
    id: args.assignment.groupId,
    maxRounds: args.assignment.maxRounds,
    currentRound: args.assignment.round,
    status: reask
      ? 'reviewing'
      : blocked
        ? 'blocked'
        : decision === 'repair'
          ? 'repairing'
          : decision === 'report-complete'
            ? 'report-complete'
            : 'passed',
    rounds: [
      ...(previous?.rounds.filter((round) => round.index !== args.assignment.round) ?? []),
      {
        index: args.assignment.round,
        candidateVersion: args.assignment.candidateVersion,
        // A seat asked again has no receipt yet, so its row reads from its new attempt.
        receipts: reask ? receipts.filter((receipt) => receipt.status !== 'crashed') : receipts
      }
    ],
    consumedRepairKeys: previous?.consumedRepairKeys ?? []
  }
  const loop = {
    groups: [...(args.loop?.groups.filter((candidate) => candidate.id !== group.id) ?? []), group]
  }
  if (reask) {
    return { loop, next: 'reask', reask: silent.map((receipt) => receipt.stepId) }
  }
  if (blocked) {
    const cause = sessionReviewBlockCause(receipts)
    return { loop, next: 'block', cause, reason: SESSION_REVIEW_BLOCK_REASONS[cause] }
  }
  return { loop, next: decision === 'repair' ? 'launch-repair' : 'finish' }
}

/** Persist before launch; replaying a consumption key cannot launch the repair twice. */
export function consumeSessionReviewRepair(
  loop: SessionReviewLoopState,
  repair: SessionReviewRepairAssignment
): { loop: SessionReviewLoopState; consumed: boolean } {
  const group = loop.groups.find((candidate) => candidate.id === repair.groupId)
  if (!group || group.consumedRepairKeys.includes(repair.consumptionKey)) {
    return { loop, consumed: false }
  }
  return {
    consumed: true,
    loop: {
      groups: loop.groups.map((candidate) =>
        candidate.id === repair.groupId
          ? {
              ...candidate,
              consumedRepairKeys: [...candidate.consumedRepairKeys, repair.consumptionKey]
            }
          : candidate
      )
    }
  }
}
