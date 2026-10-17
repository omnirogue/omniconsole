/**
 * Panes whose session published a review page and waits live for the decision (OAOS-12). The
 * hibernation tick refreshes this from main; a pane here sleeps after the review wait instead of
 * the idle window, its own review question does not hold it open, and its sleep record keeps the
 * model and effort the wake must resume with.
 */

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { ReviewSleepTarget } from '../../../shared/artifact-review-sleep'

let targets = new Map<string, ReviewSleepTarget>()

/** A failed read clears the list: without main's word, no pane gets the review exemptions. */
export async function refreshReviewSleepTargets(): Promise<void> {
  try {
    const listed = await callRuntimeRpc<ReviewSleepTarget[]>(
      { kind: 'local' },
      'artifacts.reviewSleepTargets',
      undefined,
      { timeoutMs: 10_000 }
    )
    targets = new Map(
      (Array.isArray(listed) ? listed : []).map((target) => [target.paneKey, target])
    )
  } catch {
    targets = new Map()
  }
}

export function reviewSleepTargetFor(
  paneKey: string,
  worktreeId?: string
): ReviewSleepTarget | undefined {
  const target = targets.get(paneKey)
  return target && (worktreeId === undefined || target.worktreeId === worktreeId)
    ? target
    : undefined
}

export function reviewWaitIdleMsByPaneKey(): Record<string, number> {
  return Object.fromEntries([...targets.values()].map((target) => [target.paneKey, target.idleMs]))
}

/** Tells main the wait for this pane's review now reads asleep, so a decision may resume it. */
export async function noteReviewSessionAsleep(target: {
  paneKey: string
  worktreeId: string
}): Promise<void> {
  await callRuntimeRpc({ kind: 'local' }, 'artifacts.reviewSleepNoted', target).catch(() => {})
}

export function setReviewSleepTargetsForTests(next: readonly ReviewSleepTarget[]): void {
  targets = new Map(next.map((target) => [target.paneKey, target]))
}
