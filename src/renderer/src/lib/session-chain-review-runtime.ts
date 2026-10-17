import { readSessionWorkOutput } from '@/lib/session-work-output'
import type { SourceStop } from '@/lib/session-follow-up-step'
import type {
  SessionReviewAssignment,
  SessionReviewLoopState
} from '../../../shared/session-chain-review'
import { transitionSessionReviewRound } from '../../../shared/session-chain-review-transition'
import { sessionChainPredecessors, type SessionChain } from '../../../shared/session-chain-types'

type ReviewChain = SessionChain & { reviewLoop?: SessionReviewLoopState }

export type SessionReviewBoundary =
  | { kind: 'none' }
  | { kind: 'continue'; reviewLoop: SessionReviewLoopState }
  | { kind: 'skip'; currentIndex: number; reviewLoop: SessionReviewLoopState }
  | { kind: 'blocked'; reason: string; reviewLoop: SessionReviewLoopState }

function indexAfterReviewGroup(chain: ReviewChain, groupId: string): number {
  let index = chain.currentIndex
  while (index < chain.steps.length) {
    const step = chain.steps[index] as (typeof chain.steps)[number] & {
      review?: { groupId: string }
      reviewRepair?: { groupId: string }
    }
    if (step.review?.groupId !== groupId && step.reviewRepair?.groupId !== groupId) {
      break
    }
    index += 1
  }
  return index
}

/** Evaluate the complete reviewer fan-out before any repair or later step can launch. */
export async function evaluateSessionReviewBoundary(args: {
  chain: ReviewChain
  paneKeys: readonly string[]
  stops: readonly SourceStop[]
  signal: AbortSignal
  now?: number
}): Promise<SessionReviewBoundary> {
  const reviewers = sessionChainPredecessors(args.chain, args.chain.currentIndex).filter(
    (step) => 'review' in step && step.review
  ) as (ReturnType<typeof sessionChainPredecessors>[number] & {
    review: SessionReviewAssignment
  })[]
  if (reviewers.length === 0) {
    return { kind: 'none' }
  }
  const assignment = reviewers[0]!.review
  if (
    reviewers.some(
      (step) =>
        step.review.groupId !== assignment.groupId ||
        step.review.round !== assignment.round ||
        step.review.candidateVersion !== assignment.candidateVersion
    )
  ) {
    return {
      kind: 'blocked',
      reason: 'Reviewers did not receive one immutable candidate version.',
      reviewLoop: args.chain.reviewLoop ?? { groups: [] }
    }
  }
  const outputs = await Promise.all(
    reviewers.map(async (_reviewer, index) => {
      try {
        const stop = args.stops[index]
        const paneKey = args.paneKeys[index]
        return stop && paneKey
          ? await readSessionWorkOutput(args.chain, paneKey, stop.handle, args.signal)
          : null
      } catch {
        return null
      }
    })
  )
  const next = args.chain.steps[args.chain.currentIndex] as
    | { reviewRepair?: { groupId: string } }
    | undefined
  // The one transition the host runs too (`session-outcome-review-round.ts`); a legacy chain has
  // no attempts to relaunch, so it never asks a reviewer again.
  const transition = transitionSessionReviewRound({
    loop: args.chain.reviewLoop,
    assignment,
    reviewers: reviewers.map((step, index) => ({
      stepId: step.id,
      reviewerId: step.review.reviewerId,
      output: outputs[index] ?? '',
      ...(outputs[index] === null ? { crashed: true } : {})
    })),
    hasAuthorizedRepair: next?.reviewRepair?.groupId === assignment.groupId,
    reviewOnly: !args.chain.steps.some(
      (step) => 'reviewRepair' in step && step.reviewRepair?.groupId === assignment.groupId
    ),
    now: args.now ?? Date.now()
  })
  if (transition.next === 'finish') {
    return {
      kind: 'skip',
      currentIndex: indexAfterReviewGroup(args.chain, assignment.groupId),
      reviewLoop: transition.loop
    }
  }
  if (transition.next === 'launch-repair') {
    return { kind: 'continue', reviewLoop: transition.loop }
  }
  return {
    kind: 'blocked',
    reason:
      transition.cause === 'findings'
        ? 'Review findings remain unresolved at the configured round limit.'
        : transition.reason!,
    reviewLoop: transition.loop
  }
}
