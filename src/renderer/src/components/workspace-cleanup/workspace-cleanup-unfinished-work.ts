import { useMemo } from 'react'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'

export type WorkspaceCleanupUnfinishedWork =
  | 'uncommitted-changes'
  | 'unpushed-commits'
  | 'unverified-push'
  | 'open-review'
  | 'running'

type ReviewState = Pick<WorkspaceCleanupReviewInfo, 'hasReview' | 'state'> | null | undefined

/**
 * What a workspace still holds that deleting it would lose or interrupt. Guided cleanup lists
 * these rows first, never selects them in bulk, and deletes them only on an explicit per-run opt-in.
 * Unreadable git status is not listed here: it has its own one-shot unverified-removal consent.
 * A push that could not be verified, or a linked review whose state is unknown, is listed:
 * nothing else asks before those are force-deleted.
 */
export function getWorkspaceCleanupUnfinishedWork(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git'>,
  review?: ReviewState
): WorkspaceCleanupUnfinishedWork[] {
  const work: WorkspaceCleanupUnfinishedWork[] = []
  const { blockers, git } = candidate
  if (git.clean === false || blockers.includes('dirty-files')) {
    work.push('uncommitted-changes')
  }
  if ((git.upstreamAhead ?? 0) > 0 || blockers.includes('unpushed-commits')) {
    work.push('unpushed-commits')
  } else if (blockers.includes('unknown-base')) {
    work.push('unverified-push')
  }
  if (review?.hasReview && review.state !== 'merged' && review.state !== 'closed') {
    work.push('open-review')
  }
  if (
    blockers.includes('running-terminal') ||
    blockers.includes('live-agent') ||
    blockers.includes('terminal-liveness-unknown')
  ) {
    work.push('running')
  }
  return work
}

export function hasWorkspaceCleanupUnfinishedWork(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git'>,
  review?: ReviewState
): boolean {
  return getWorkspaceCleanupUnfinishedWork(candidate, review).length > 0
}

/** Stable partition: rows with unfinished work first, each part in the caller's sort order. */
export function orderUnfinishedWorkFirst<Row>(
  rows: readonly Row[],
  hasUnfinishedWork: (row: Row) => boolean
): Row[] {
  const unfinished: Row[] = []
  const rest: Row[] = []
  for (const row of rows) {
    ;(hasUnfinishedWork(row) ? unfinished : rest).push(row)
  }
  return [...unfinished, ...rest]
}

/**
 * Applied after the list's frozen streaming order: git evidence arrives after the order is
 * frozen, and a workspace found to hold work must still move to the top.
 */
export function useUnfinishedWorkFirst<
  Row extends {
    candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git'>
    review?: ReviewState
  }
>(rows: readonly Row[]): Row[] {
  return useMemo(
    () =>
      orderUnfinishedWorkFirst(rows, (row) =>
        hasWorkspaceCleanupUnfinishedWork(row.candidate, row.review)
      ),
    [rows]
  )
}
