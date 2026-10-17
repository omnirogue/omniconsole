import {
  archiveSummary,
  retainedReason,
  summarizeStoredArchive,
  type WorkerReleaseReceipt,
  type WorkerTerminalReleaseArgs
} from './orchestration-worker-release-receipt'
export {
  archiveSummary,
  exposeWorkerTerminalResource,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-receipt'
import {
  captureWorkerReleaseProcessTree,
  finishWorkerReleaseProcessTree,
  readWorkerReleaseProcessTree,
  mergeWorkerReleaseProcessTrees
} from '../../orchestration/worker-release-process-tree'
import { readWorkerCompletionPolicy } from '../../../../shared/orchestration-worker-completion-policy'
import {
  noteReleasedWorkerReviewsAsleep,
  workerReviewReleaseHold
} from '../../../artifacts/artifact-review-worker-release'
import { captureWorkerReviewHandoff } from '../../../artifacts/artifact-review-worker-checkpoint'
import {
  recoverWorkerReleaseProcessTree,
  workerReleasePolicyHold
} from './orchestration-worker-release-policy-recovery'
import type { WorkerTerminalArchiveStatus } from '../../orchestration/worker-terminal-ownership'
import { captureWorkerOutputArchive } from '../../orchestration/worker-output-archive'
import { closeWorkerTerminalForRelease } from './orchestration-worker-release-close'
import { inspectWorkerTerminal } from './orchestration-worker-observation'
import { orchestrationTimestampToMs } from './orchestration-worker-output'
import { workerTerminalReleaseLeaseIsCurrent } from './orchestration-worker-terminal-lease'
import { runWorkerReleaseOnce } from './orchestration-worker-release-activity'

// Re-proves identity, freezes output and closes the exact terminal for RPC and recovery.
export function completeWorkerTerminalRelease(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  return runWorkerReleaseOnce(args.runtime, args.resource.id, () =>
    completeWorkerTerminalReleaseOnce(args)
  )
}

async function completeWorkerTerminalReleaseOnce(
  args: WorkerTerminalReleaseArgs
): Promise<WorkerReleaseReceipt> {
  const { runtime, db, dispatchId, resource } = args
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker || worker.agent_terminal_handle !== resource.terminal_handle) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: retained.release_state === 'retained' ? 'retained' : 'release_pending',
      ...(retained.release_state === 'retained' ? { reason: 'identity_unproven' as const } : {}),
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }
  const policy = readWorkerCompletionPolicy(worker.start_options)
  const recovered = policy && (await recoverWorkerReleaseProcessTree(args))
  if (recovered) {
    return recovered
  }
  if (args.mode === 'recovery' && resource.release_state === 'unknown') {
    return {
      dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: archiveSummary(resource),
      recovery: 'The issued close has no exact exit proof; preserve its recovery obligation.'
    }
  }
  const held = await workerReleasePolicyHold(args, policy)
  if (held) {
    return held
  }
  const observation = await inspectWorkerTerminal(runtime, db, dispatchId)
  if (observation.status === 'identity_changed') {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: retained.release_state === 'retained' ? 'retained' : 'release_pending',
      ...(retained.release_state === 'retained' ? { reason: 'identity_unproven' as const } : {}),
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }
  if (!workerTerminalReleaseLeaseIsCurrent(runtime, db, dispatchId, resource)) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: retained.release_state === 'retained' ? 'retained' : 'release_pending',
      ...(retained.release_state === 'retained' ? { reason: 'identity_unproven' as const } : {}),
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }
  if (observation.status === 'missing' || observation.status === 'unattached') {
    if (args.mode === 'recovery') {
      // Inventory may still be incomplete during startup/reconnect discovery; defer.
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'none',
        archive: archiveSummary(resource),
        recovery:
          'The recorded terminal has not been rediscovered yet; recovery will retry after the next terminal inventory.'
      }
    }
    // Why: the handle resolves nowhere, but the PTY could have been re-homed after a restart —
    // claiming released would hide a live process; only an exact observation may settle it.
    const unknown = db.markWorkerTerminalReleaseUnknown(
      resource.id,
      'The recorded terminal no longer resolves; whether its process is gone cannot be proven.'
    )
    return {
      dispatchId,
      state: 'release_unknown',
      processAction: 'none',
      archive: archiveSummary(unknown),
      lastError: unknown.release_error ?? undefined,
      recovery: `Inspect with: omni orchestration worker-show --dispatch ${dispatchId} --json — then repeat worker-release with the same --retry-request. Never substitute a broad terminal close.`
    }
  }

  const archive = db.getWorkerTerminalArchive(dispatchId)
  const freshTree = policy ? await captureWorkerReleaseProcessTree(runtime, resource) : null
  const priorTree = archive && readWorkerReleaseProcessTree(archive.content, resource)
  const releaseProcessTree =
    freshTree && priorTree ? mergeWorkerReleaseProcessTrees(priorTree, freshTree) : freshTree
  if (policy && !releaseProcessTree) {
    throw new Error('Disposable worker descendant checkpoint is unavailable; terminal retained.')
  }
  let archiveSource = resource.archive_source as 'transcript' | 'terminal' | null
  let archiveStatus: WorkerTerminalArchiveStatus | null = resource.archive_status
  let capturedArchive: { kind: 'transcript_pin' | 'terminal_tail'; content: string } | undefined
  if (
    !archive ||
    (policy && db.getWorkerTerminalReleaseClosePhase(dispatchId, resource.id) === 'prepared')
  ) {
    const captured = await captureWorkerOutputArchive({
      runtime,
      dispatchId,
      terminalHandle: resource.terminal_handle,
      attachedAtMs: orchestrationTimestampToMs(worker.created_at),
      requireResume: Boolean(policy),
      ...(resource.host_scope && resource.worktree_id
        ? {
            resumeContext: {
              hostScope: resource.host_scope,
              worktreeId: resource.worktree_id,
              accountChoiceId:
                typeof JSON.parse(worker.start_options).accountChoiceId === 'string'
                  ? JSON.parse(worker.start_options).accountChoiceId
                  : null
            }
          }
        : {})
    })
    capturedArchive = {
      kind: captured.kind,
      content: JSON.stringify({
        ...captured.content,
        ...(policy ? { reviewHandoff: captureWorkerReviewHandoff(runtime, resource) } : {}),
        ...(releaseProcessTree ? { releaseProcessTree } : {})
      })
    }
    archiveSource = captured.kind === 'transcript_pin' ? 'transcript' : 'terminal'
    archiveStatus = captured.status
  } else {
    if (releaseProcessTree) {
      capturedArchive = {
        kind: archive.kind,
        content: JSON.stringify({ ...JSON.parse(archive.content), releaseProcessTree })
      }
    }
    const stored = summarizeStoredArchive(archive)
    archiveSource ??= stored.source
    archiveStatus ??= stored.status
  }
  const releasing = db.commitWorkerTerminalArchiveForRelease({
    dispatchId,
    resourceId: resource.id,
    ...capturedArchive,
    archiveSource,
    archiveStatus: archiveStatus === 'empty' ? 'empty' : 'captured'
  })
  if (releasing.ownership_state !== 'owned' || releasing.release_state !== 'releasing') {
    return {
      dispatchId,
      state: 'retained',
      reason: retainedReason(releasing),
      processAction: 'none',
      archive: archiveSummary(releasing)
    }
  }
  if (!workerTerminalReleaseLeaseIsCurrent(runtime, db, dispatchId, releasing)) {
    const retained = db.revertWorkerTerminalReleaseToRetained(resource.id, 'identity_unproven')
    return {
      dispatchId,
      state: retained.release_state === 'retained' ? 'retained' : 'release_pending',
      ...(retained.release_state === 'retained' ? { reason: 'identity_unproven' as const } : {}),
      processAction: 'none',
      archive: archiveSummary(retained)
    }
  }

  const finalHold = await workerReleasePolicyHold(args, policy)
  if (finalHold) {
    return finalHold
  }
  if (!workerTerminalReleaseLeaseIsCurrent(runtime, db, dispatchId, releasing)) {
    return {
      dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: archiveSummary(releasing)
    }
  }
  const currentBeforeClose = db.getWorkerTerminalResource(resource.id)
  if (
    currentBeforeClose?.ownership_state !== 'owned' ||
    currentBeforeClose.owner_dispatch_id !== dispatchId ||
    currentBeforeClose.release_state !== 'releasing'
  ) {
    return {
      dispatchId,
      state: 'retained',
      reason: currentBeforeClose ? retainedReason(currentBeforeClose) : 'identity_unproven',
      processAction: 'none',
      archive: archiveSummary(currentBeforeClose ?? null)
    }
  }
  if (!db.markWorkerTerminalReleaseCloseIssued(dispatchId, resource.id)) {
    const current = db.getWorkerTerminalResource(resource.id)
    return {
      dispatchId,
      state: current?.release_state === 'retained' ? 'retained' : 'release_pending',
      ...(current?.release_state === 'retained' ? { reason: retainedReason(current) } : {}),
      processAction: 'none',
      archive: archiveSummary(current ?? null)
    }
  }
  // Why: a decision receipt or revision pinned between the final hold and the persisted close
  // phase must be found while Keep is still possible, not after the terminal is gone.
  const lateReviewHold = policy ? workerReviewReleaseHold(runtime, db, resource) : null
  if (lateReviewHold) {
    db.rewindWorkerTerminalReleaseCloseToPrepared(dispatchId, resource.id)
    return {
      dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: { source: archiveSource, status: archiveStatus },
      recovery: lateReviewHold
    }
  }
  const closeFailure = await closeWorkerTerminalForRelease(runtime, db, dispatchId, resource, {
    source: archiveSource,
    status: archiveStatus
  })
  if (closeFailure) {
    return closeFailure
  }
  if (releaseProcessTree) {
    const verdict = await finishWorkerReleaseProcessTree(releaseProcessTree)
    if (verdict !== 'exited') {
      return {
        dispatchId,
        state: 'release_pending',
        processAction: 'closed_agent_terminal',
        archive: { source: archiveSource, status: archiveStatus },
        lastError: `Captured descendants remain ${verdict}; cleanup will reconcile the saved identities.`
      }
    }
  }
  if (policy) {
    noteReleasedWorkerReviewsAsleep(runtime, db, resource)
  }
  const released = db.settleWorkerTerminalRelease(resource.id)
  runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  return {
    dispatchId,
    state: 'released',
    processAction:
      observation.status === 'exited' ? 'closed_exited_terminal' : 'closed_agent_terminal',
    archive: archiveSummary(released)
  }
}
