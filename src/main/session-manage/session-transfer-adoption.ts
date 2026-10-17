/**
 * Adoption (Phase 3 §3): after the target acknowledged a handoff or merge and before any source is
 * archived, work that waits on a source follows the target, so a waiter is woken by the target's
 * result instead of by an archived session. Session waits (WP-S3) register the re-pointer; until
 * they run on this computer there is nothing to adopt. A failure stops the transfer before archive.
 */

import type { TransferSession } from './session-manage-transfer-contract'

/** Moves every wait on `from` (a pane key) to `to`; returns how many it moved. */
export type SessionWaitRepointer = (input: { from: string; to: string }) => Promise<number>

let repointer: SessionWaitRepointer | null = null

/** Returns the restore. */
export function setSessionWaitRepointer(next: SessionWaitRepointer | null): () => void {
  const previous = repointer
  repointer = next
  return () => {
    repointer = previous
  }
}

/** What the target now carries for the sources; null when nothing waited on them. */
export async function adoptTransferredWork(input: {
  sources: readonly TransferSession[]
  target: TransferSession
}): Promise<string | null> {
  const to = input.target.entry.paneKey
  if (!repointer || !to) {
    return null
  }
  let moved = 0
  for (const source of input.sources) {
    const from = source.entry.paneKey
    if (from && from !== to) {
      moved += await repointer({ from, to })
    }
  }
  return moved > 0
    ? `${moved} wait${moved === 1 ? '' : 's'} on the source now follow${moved === 1 ? 's' : ''} “${input.target.entry.title}”`
    : null
}
