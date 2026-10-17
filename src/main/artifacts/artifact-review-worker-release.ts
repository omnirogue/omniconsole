import { hostname } from 'node:os'
import { isAbsolute } from 'node:path'
import { validArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { conversationProfileOf } from '../../shared/conversation-resume-command'
import type { OrchestrationWorkerResumeManifest } from '../../shared/orchestration-worker-output'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { WorkerTerminalResourceRow } from '../runtime/orchestration/worker-terminal-ownership'
import { orchestrationTimestampToMs } from '../runtime/rpc/methods/orchestration-worker-output'
import type { ArtifactShareRecord } from './artifact-share-record-store'
import { saveArtifactReviewSleep } from './artifact-share-record-sleep'
import { validArtifactSourceReview, type ArtifactSourceReview } from './artifact-source-review'
import {
  captureWorkerReviewHandoff,
  readWorkerReviewHandoff,
  reviewBoundToWorker,
  workerReviewRecords
} from './artifact-review-worker-checkpoint'

/** The archive is the release's durable identity proof, not a new review authority. */
function archivedResume(
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow,
  userDataPath: string
): OrchestrationWorkerResumeManifest | null {
  const archive = db.getWorkerTerminalArchive(resource.owner_dispatch_id)
  try {
    const resume =
      archive && (JSON.parse(archive.content).resume as OrchestrationWorkerResumeManifest)
    const execution = resume?.execution
    const host = resource.host_scope && JSON.parse(resource.host_scope)
    const agent = resume?.agent === 'claude' ? 'claude' : resume?.agent === 'codex' ? 'codex' : null
    return resume &&
      execution &&
      host?.kind === 'local' &&
      host.hostId === 'local' &&
      execution.hostname === hostname() &&
      execution.profilePath === userDataPath &&
      execution.hostScope === resource.host_scope &&
      execution.worktreeId === resource.worktree_id &&
      typeof execution.worktreePath === 'string' &&
      isAbsolute(execution.worktreePath) &&
      typeof execution.accountHome === 'string' &&
      isAbsolute(execution.accountHome) &&
      resume.processIncarnation === resource.process_incarnation &&
      agent &&
      typeof resume.providerSessionId === 'string' &&
      resume.providerSessionId.length > 0 &&
      typeof resume.transcriptPath === 'string' &&
      conversationProfileOf(agent, resume.transcriptPath)?.path === execution.accountHome
      ? resume
      : null
  } catch {
    return null
  }
}

function safeWaitingReview(
  record: ArtifactShareRecord,
  resume: {
    agent: string
    providerSessionId: string
    transcriptPath: string | null
  },
  cwd?: string,
  // Why: before close, a decision in flight keeps the live worker. After the exact exit, the
  // same receipt is simply a wake reason; recording sleep lets the normal wake path deliver it.
  options: { afterExit?: boolean } = {}
): boolean {
  const { sleep, sourceReview } = record
  return (
    validArtifactSourceReview(sourceReview) &&
    validArtifactReviewSleep(sleep) &&
    sleep.revision === sourceReview.revision &&
    ['waiting', 'asleep'].includes(sleep.state) &&
    (options.afterExit === true || sourceReview.receipt === undefined) &&
    sleep.provider === resume.agent &&
    sourceReview.nativeSessionId === resume.providerSessionId &&
    sleep.transcriptPath === resume.transcriptPath &&
    !!sleep.accountHome &&
    conversationProfileOf(sleep.provider, sleep.transcriptPath!)?.path === sleep.accountHome &&
    !!sleep.cwd &&
    isAbsolute(sleep.cwd) &&
    !!sleep.workspace &&
    sleep.workspace.path === sleep.cwd &&
    sleep.workspace.worktreeId === sourceReview.worktreeId &&
    (cwd === undefined || sleep.cwd === cwd)
  )
}

/** A review with no proven wake path still owns its execution session. */
export function workerReviewReleaseHold(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow
): string | null {
  const userDataPath = getProfileUserDataPath()
  const handoff = captureWorkerReviewHandoff(runtime, resource)
  const archive = db.getWorkerTerminalArchive(resource.owner_dispatch_id)
  const checkpoint = archive ? readWorkerReviewHandoff(archive.content) : undefined
  if (checkpoint !== undefined && JSON.stringify(checkpoint) !== JSON.stringify(handoff)) {
    return 'The bound review scope changed during release; keep its execution session available.'
  }
  if (!handoff) {
    return null
  }
  const entries = workerReviewRecords(handoff, userDataPath)
  const worker = db.getWorkerDispatch(resource.owner_dispatch_id)
  const session =
    worker &&
    runtime.getExactWorkerProviderSession(
      resource.terminal_handle,
      orchestrationTimestampToMs(worker.created_at)
    )
  if (!session || session.processIncarnation !== resource.process_incarnation) {
    return 'A bound review has no exact live provider identity; keep its execution session available.'
  }
  const resume = {
    agent: session.agent,
    providerSessionId: session.providerSession.id,
    transcriptPath: session.providerSession.transcriptPath ?? null
  }
  const saved = archive ? archivedResume(db, resource, userDataPath) : null
  if (
    archive &&
    (!saved ||
      saved.providerSessionId !== resume.providerSessionId ||
      saved.agent !== resume.agent ||
      saved.transcriptPath !== resume.transcriptPath)
  ) {
    return 'A bound review does not match the archived resume identity; keep its execution session available.'
  }
  return entries.every(({ record }) =>
    safeWaitingReview(record, resume, saved?.execution?.worktreePath)
  )
    ? null
    : 'A bound review is kept, unarmed, changed, or receiving a decision; keep its execution session available.'
}

/** Called only after exact PTY and descendant exit, before settling the durable release. */
export function noteReleasedWorkerReviewsAsleep(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  resource: WorkerTerminalResourceRow,
  now = Date.now()
): void {
  const userDataPath = getProfileUserDataPath()
  const archive = db.getWorkerTerminalArchive(resource.owner_dispatch_id)
  const handoff = archive && readWorkerReviewHandoff(archive.content)
  // Older checkpoints use the current scope; new releases pin it before any close is issued.
  const bound = handoff === undefined ? captureWorkerReviewHandoff(runtime, resource) : handoff
  if (handoff === null && captureWorkerReviewHandoff(runtime, resource)) {
    throw new Error(
      'A review appeared after release preparation; preserve its recovery obligation.'
    )
  }
  if (!bound) {
    return
  }
  const entries = workerReviewRecords(bound, userDataPath, { afterExit: true })
  const resume = archivedResume(db, resource, userDataPath)
  if (
    !resume ||
    entries.some(
      ({ entry, record }) =>
        !reviewBoundToWorker(entry.sourceReview, resource) ||
        !safeWaitingReview(record, resume, resume.execution!.worktreePath, { afterExit: true })
    )
  ) {
    throw new Error(
      'Worker exited, but its review resume handoff changed; release recovery must retain this obligation.'
    )
  }
  for (const { entry, record } of entries) {
    if (record.sleep!.state === 'asleep') {
      continue
    }
    if (
      !saveArtifactReviewSleep(
        bound.profileId,
        userDataPath,
        entry.sourceKey,
        bound.scope,
        { slug: record.slug, sourceReview: record.sourceReview! },
        { ...record.sleep!, state: 'asleep', sleptAt: now, at: now }
      )
    ) {
      throw new Error(
        'Worker exited, but its review sleep state was not saved; release recovery will retry.'
      )
    }
  }
}

/**
 * A close in flight must finish its sleep receipt before a review can wake or deliver.
 * An unconfirmed close ('unknown') is still an issued close: its terminal may be visible while
 * its process is going away, so delivery waits for exact exit evidence through release retry.
 */
export function workerReviewDeliveryHeld(
  db: OrchestrationDb,
  binding: ArtifactSourceReview
): boolean {
  return db
    .listWorkerTerminalUnsettledCloses()
    .some(
      (resource) =>
        resource.ownership_state === 'owned' &&
        (resource.release_state === 'releasing' || resource.release_state === 'unknown') &&
        reviewBoundToWorker(binding, resource) &&
        db.getWorkerTerminalReleaseClosePhase(resource.owner_dispatch_id, resource.id) !==
          'prepared'
    )
}
