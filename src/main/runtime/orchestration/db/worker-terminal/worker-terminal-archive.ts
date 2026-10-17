import type {
  WorkerTerminalResourceRow,
  WorkerTerminalArchiveRow,
  WorkerTerminalArchiveStatus,
  WorkerTerminalRetainedReason
} from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  archiveWithWorkerTerminalClosePhase,
  archiveWithPriorWorkerTerminalClosePhase,
  archiveWithoutWorkerTerminalClosePhase,
  readWorkerTerminalClosePhase
} from './worker-terminal-close-phase'
import {
  attachWorkerTerminalClosePhase,
  type WorkerTerminalClosePhaseMethods
} from './worker-terminal-close-phase-db'

export function storeWorkerTerminalArchive(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    resourceId: string
    kind: 'transcript_pin' | 'terminal_tail'
    content: string
  }
): void {
  this.db
    .prepare(
      `INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(dispatch_id) DO UPDATE SET
         resource_id = excluded.resource_id, kind = excluded.kind, content = excluded.content`
    )
    .run(params.dispatchId, params.resourceId, params.kind, params.content)
}

export function commitWorkerTerminalArchiveForRelease(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    resourceId: string
    kind?: 'transcript_pin' | 'terminal_tail'
    content?: string
    archiveSource: 'transcript' | 'terminal'
    archiveStatus: Extract<WorkerTerminalArchiveStatus, 'captured' | 'empty'>
  }
): WorkerTerminalResourceRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(params.resourceId)
    if (!resource) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Worker terminal resource ${params.resourceId} was not found.`
      )
    }
    if (
      resource.owner_dispatch_id === params.dispatchId &&
      resource.ownership_state === 'owned' &&
      ['requested', 'releasing'].includes(resource.release_state)
    ) {
      const prior = this.getWorkerTerminalArchive(params.dispatchId)
      const priorPhase = readWorkerTerminalClosePhase(prior, resource)
      if (params.kind && params.content !== undefined) {
        this.storeWorkerTerminalArchive({
          dispatchId: params.dispatchId,
          resourceId: params.resourceId,
          kind: params.kind,
          content:
            priorPhase !== 'unknown' || (!prior && resource.release_state === 'requested')
              ? archiveWithWorkerTerminalClosePhase(
                  params.content,
                  resource,
                  priorPhase === 'unknown' ? 'prepared' : priorPhase
                )
              : prior
                ? archiveWithPriorWorkerTerminalClosePhase(params.content, prior.content)
                : archiveWithoutWorkerTerminalClosePhase(params.content)
        })
      } else if (!prior) {
        throw new OrchestrationError('archive_failed', 'Worker terminal output is not archived.')
      }
      const archive = this.getWorkerTerminalArchive(params.dispatchId)
      if (!archive || archive.resource_id !== params.resourceId) {
        throw new OrchestrationError(
          'archive_failed',
          `Output could not be preserved for Dispatch ${params.dispatchId}; the terminal was retained.`
        )
      }
      this.db
        .prepare(
          `UPDATE worker_terminal_resources
           SET release_state = 'releasing', archive_source = ?, archive_status = ?,
               updated_at = datetime('now')
           WHERE id = ? AND owner_dispatch_id = ? AND ownership_state = 'owned'
             AND release_state = 'requested'`
        )
        .run(params.archiveSource, params.archiveStatus, params.resourceId, params.dispatchId)
    }
    const updated = this.getWorkerTerminalResource(params.resourceId) as WorkerTerminalResourceRow
    this.db.exec('COMMIT')
    return updated
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getWorkerTerminalArchive(
  this: OrchestrationDb,
  dispatchId: string
): WorkerTerminalArchiveRow | undefined {
  return this.db
    .prepare('SELECT * FROM worker_terminal_archives WHERE dispatch_id = ?')
    .get(dispatchId) as WorkerTerminalArchiveRow | undefined
}

export function settleWorkerTerminalRelease(
  this: OrchestrationDb,
  resourceId: string
): WorkerTerminalResourceRow {
  this.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET release_state = 'released', ownership_state = 'released',
           release_completed_at = datetime('now'), release_error = NULL,
           updated_at = datetime('now')
       WHERE id = ? AND release_state IN ('requested', 'releasing', 'unknown')`
    )
    .run(resourceId)
  return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
}

export function markWorkerTerminalReleaseUnknown(
  this: OrchestrationDb,
  resourceId: string,
  reason: string
): WorkerTerminalResourceRow {
  this.db
    .prepare(
      `UPDATE worker_terminal_resources
       SET release_state = 'unknown', release_error = ?, updated_at = datetime('now')
       WHERE id = ? AND release_state IN ('requested', 'releasing')`
    )
    .run(reason, resourceId)
  return this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
}

export function revertWorkerTerminalReleaseToRetained(
  this: OrchestrationDb,
  resourceId: string,
  reason: WorkerTerminalRetainedReason
): WorkerTerminalResourceRow {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(resourceId)
    if (resource && !this.workerTerminalReleaseCanRetain(resource)) {
      this.db.exec('COMMIT')
      return resource
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
       SET release_state = 'retained', retained_reason = ?, updated_at = datetime('now')
       WHERE id = ? AND release_state IN ('requested', 'releasing')`
      )
      .run(reason, resourceId)
    const updated = this.getWorkerTerminalResource(resourceId) as WorkerTerminalResourceRow
    this.db.exec('COMMIT')
    return updated
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function retainWorkerTerminalResource(
  this: OrchestrationDb,
  dispatchId: string,
  allowReleasing = false,
  expectedIdentity?: { paneKey: string; processIncarnation: string }
):
  | { disposition: 'retained'; resource: WorkerTerminalResourceRow }
  | { disposition: 'already_released'; resource: WorkerTerminalResourceRow }
  | { disposition: 'release_committed'; resource: WorkerTerminalResourceRow }
  | { disposition: 'stale_identity'; resource: WorkerTerminalResourceRow | null }
  | { disposition: 'no_owned_resource'; resource: null } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    const worker = this.getWorkerDispatch(dispatchId)
    if (!worker && !['completed', 'failed', 'circuit_broken'].includes(dispatch.status)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is ${dispatch.status}; only a settled dispatch can retain.`
      )
    }
    const resource = this.getWorkerTerminalResourceByOwner(dispatchId)
    if (!resource) {
      this.db.exec('COMMIT')
      return expectedIdentity
        ? { disposition: 'stale_identity', resource: null }
        : { disposition: 'no_owned_resource', resource: null }
    }
    if (
      expectedIdentity &&
      (resource.pane_key !== expectedIdentity.paneKey ||
        resource.process_incarnation !== expectedIdentity.processIncarnation)
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'stale_identity', resource }
    }
    if (resource.release_state === 'released') {
      this.db.exec('COMMIT')
      return { disposition: 'already_released', resource }
    }
    if (!this.workerTerminalReleaseCanRetain(resource)) {
      this.db.exec('COMMIT')
      return { disposition: 'release_committed', resource }
    }
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'retained', retained_reason = 'user_requested',
             updated_at = datetime('now')
         WHERE id = ? AND release_state IN ('not_requested', 'retained', 'requested'${allowReleasing ? ", 'releasing'" : ''})
           ${expectedIdentity ? 'AND pane_key = ? AND process_incarnation = ?' : ''}`
      )
      .run(
        resource.id,
        ...(expectedIdentity ? [expectedIdentity.paneKey, expectedIdentity.processIncarnation] : [])
      )
    const updated = this.getWorkerTerminalResource(resource.id) as WorkerTerminalResourceRow
    if (
      expectedIdentity &&
      (updated.pane_key !== expectedIdentity.paneKey ||
        updated.process_incarnation !== expectedIdentity.processIncarnation)
    ) {
      this.db.exec('COMMIT')
      return { disposition: 'stale_identity', resource: updated }
    }
    if (updated.release_state !== 'retained') {
      this.db.exec('COMMIT')
      return { disposition: 'release_committed', resource: updated }
    }
    this.db.prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?').run(dispatchId)
    this.db.exec('COMMIT')
    return { disposition: 'retained', resource: updated }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalArchiveMethods = WorkerTerminalClosePhaseMethods & {
  storeWorkerTerminalArchive: typeof storeWorkerTerminalArchive
  commitWorkerTerminalArchiveForRelease: typeof commitWorkerTerminalArchiveForRelease
  getWorkerTerminalArchive: typeof getWorkerTerminalArchive
  settleWorkerTerminalRelease: typeof settleWorkerTerminalRelease
  markWorkerTerminalReleaseUnknown: typeof markWorkerTerminalReleaseUnknown
  revertWorkerTerminalReleaseToRetained: typeof revertWorkerTerminalReleaseToRetained
  retainWorkerTerminalResource: typeof retainWorkerTerminalResource
}

export function attachWorkerTerminalArchive(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    storeWorkerTerminalArchive,
    commitWorkerTerminalArchiveForRelease,
    getWorkerTerminalArchive,
    settleWorkerTerminalRelease,
    markWorkerTerminalReleaseUnknown,
    revertWorkerTerminalReleaseToRetained,
    retainWorkerTerminalResource
  })
  attachWorkerTerminalClosePhase(ctor)
}
