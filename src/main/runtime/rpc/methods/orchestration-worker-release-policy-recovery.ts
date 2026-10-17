import type { WorkerCompletionPolicy } from '../../../../shared/orchestration-worker-completion-policy'
import {
  noteReleasedWorkerReviewsAsleep,
  workerReviewReleaseHold
} from '../../../artifacts/artifact-review-worker-release'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { workerHasOpenObligations } from '../../orchestration/db/worker-terminal/worker-terminal-accepted-release'
import type { WorkerTerminalResourceRow } from '../../orchestration/worker-terminal-ownership'
import {
  finishWorkerReleaseProcessTree,
  readWorkerReleaseProcessTree
} from '../../orchestration/worker-release-process-tree'
import { assertWorkerCompletionPolicyAllowed } from './orchestration-worker-completion-policy'
import { workerHasNativeObligations } from '../../orchestration/worker-native-obligations'
import {
  archiveSummary,
  retainedReason,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-receipt'

type ReleasePolicyArgs = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dispatchId: string
  resource: WorkerTerminalResourceRow
}

export async function recoverWorkerReleaseProcessTree({
  runtime,
  db,
  dispatchId,
  resource
}: ReleasePolicyArgs): Promise<WorkerReleaseReceipt | null> {
  const savedArchive = db.getWorkerTerminalArchive(dispatchId)
  const savedTree = savedArchive && readWorkerReleaseProcessTree(savedArchive.content, resource)
  if (
    !savedTree ||
    (resource.release_state === 'unknown' &&
      db.getWorkerTerminalReleaseClosePhase(dispatchId, resource.id) === 'prepared') ||
    resource.ownership_state !== 'owned' ||
    resource.owner_dispatch_id !== dispatchId ||
    !['releasing', 'unknown'].includes(resource.release_state) ||
    db.workerTerminalResourceHasIdentityConflict(resource.id)
  ) {
    return null
  }
  const liveness = await runtime.inspectTerminalProcessIncarnationLiveness(
    savedTree.processIncarnation,
    savedTree.hostScope
  )
  if (liveness === 'exited') {
    // The exact recorded PTY has exited. Its tab may already be gone, so tab protection
    // cannot gate cleanup of descendants captured and archived before the close.
    const before = db.getWorkerTerminalResource(resource.id)
    if (
      before?.ownership_state !== 'owned' ||
      before.owner_dispatch_id !== dispatchId ||
      !['releasing', 'unknown'].includes(before.release_state) ||
      db.workerTerminalResourceHasIdentityConflict(resource.id)
    ) {
      return null
    }
    const verdict = await finishWorkerReleaseProcessTree(savedTree)
    const current = db.getWorkerTerminalResource(resource.id)
    if (
      current?.ownership_state === 'owned' &&
      current.owner_dispatch_id === dispatchId &&
      ['releasing', 'unknown'].includes(current.release_state) &&
      !db.workerTerminalResourceHasIdentityConflict(resource.id)
    ) {
      if (verdict === 'exited') {
        noteReleasedWorkerReviewsAsleep(runtime, db, current)
        return {
          dispatchId,
          state: 'released',
          processAction: 'closed_agent_terminal',
          archive: archiveSummary(db.settleWorkerTerminalRelease(resource.id))
        }
      }
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(current),
        lastError: `Captured descendants remain ${verdict}; physical PTY exit alone did not settle cleanup.`
      }
    }
    return {
      dispatchId,
      state: 'retained',
      reason: 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(current ?? null)
    }
  }
  if (liveness === 'unverifiable') {
    return {
      dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: archiveSummary(resource),
      recovery: 'The recorded PTY exit is unverified; recovery will retry its exact identity.'
    }
  }
  if (
    resource.worktree_id &&
    resource.pane_key &&
    !runtime.getAutomaticCleanupTab(resource.worktree_id, resource.pane_key)
  ) {
    return {
      dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: archiveSummary(resource),
      recovery:
        'The recorded PTY is live but its exact terminal is not in inventory; recovery will retry.'
    }
  }
  return resource.release_state === 'unknown'
    ? {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery: 'The issued close remains unconfirmed; recovery requires exact exit evidence.'
      }
    : null
}

export async function workerReleasePolicyHold(
  { runtime, db, dispatchId, resource }: ReleasePolicyArgs,
  policy: WorkerCompletionPolicy | null
): Promise<WorkerReleaseReceipt | null> {
  if (!policy) {
    return null
  }
  const reason = 'protection_held'
  try {
    if (!resource.worktree_id || !resource.pane_key) {
      throw new Error('Worker cleanup identity is unavailable.')
    }
    await assertWorkerCompletionPolicyAllowed(runtime, policy, {
      worktreeId: resource.worktree_id,
      paneKey: resource.pane_key
    })
    if (
      workerHasOpenObligations(db, dispatchId) ||
      workerHasNativeObligations(runtime, db, resource)
    ) {
      return {
        dispatchId,
        state: 'release_pending',
        reason: 'pending_obligations',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery:
          'Accepted cleanup is waiting for open questions, unread mail, or child work. The execution owner will retry after these obligations settle.'
      }
    }
    const reviewHold = workerReviewReleaseHold(runtime, db, resource)
    if (reviewHold) {
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery: reviewHold
      }
    }
    return null
  } catch (error) {
    // A live worker held by protection is an ordinary retained conversation again.
    const current = db.getWorkerTerminalResource(resource.id)
    if (
      current?.ownership_state !== 'owned' ||
      current.owner_dispatch_id !== dispatchId ||
      !['requested', 'releasing'].includes(current.release_state)
    ) {
      return {
        dispatchId,
        state: 'retained',
        reason: current ? retainedReason(current) : 'identity_unproven',
        processAction: 'none',
        archive: archiveSummary(current ?? null)
      }
    }
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, reason)
    if (retained.release_state !== 'retained') {
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(retained),
        lastError: error instanceof Error ? error.message : String(error),
        recovery: 'A close may already have been issued; exact release recovery will retry.'
      }
    }
    return {
      dispatchId,
      state: 'retained',
      reason,
      processAction: 'none',
      archive: archiveSummary(retained),
      lastError: error instanceof Error ? error.message : String(error),
      recovery:
        'Cleanup was held by the execution owner. The live worker remains retained; resolve its obligations or protection, then reuse it or request exact release.'
    }
  }
}
