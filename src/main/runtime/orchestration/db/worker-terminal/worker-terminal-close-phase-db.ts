import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerTerminalResourceRow } from '../../worker-terminal-ownership'
import {
  archiveWithWorkerTerminalClosePhase,
  archiveHasWorkerTerminalClosePhase,
  readWorkerTerminalClosePhase,
  type WorkerTerminalClosePhase
} from './worker-terminal-close-phase'

export function getWorkerTerminalReleaseClosePhase(
  this: OrchestrationDb,
  dispatchId: string,
  resourceId: string
): WorkerTerminalClosePhase {
  const resource = this.getWorkerTerminalResource(resourceId)
  return resource?.owner_dispatch_id === dispatchId
    ? readWorkerTerminalClosePhase(this.getWorkerTerminalArchive(dispatchId), resource)
    : 'unknown'
}

export function workerTerminalReleaseCanRetain(
  this: OrchestrationDb,
  resource: WorkerTerminalResourceRow
): boolean {
  if (!['requested', 'releasing'].includes(resource.release_state)) {
    return true
  }
  const archive = this.getWorkerTerminalArchive(resource.owner_dispatch_id)
  // A fresh request has not reached the close path. Once archived, only exact prepared
  // evidence permits retention; missing legacy evidence cannot prove no close was issued.
  return resource.release_state === 'requested' && !archive
    ? true
    : readWorkerTerminalClosePhase(archive, resource) === 'prepared'
}

export function markWorkerTerminalReleaseCloseIssued(
  this: OrchestrationDb,
  dispatchId: string,
  resourceId: string
): boolean {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(resourceId)
    const archive = this.getWorkerTerminalArchive(dispatchId)
    if (
      !resource ||
      resource.owner_dispatch_id !== dispatchId ||
      resource.ownership_state !== 'owned' ||
      resource.release_state !== 'releasing' ||
      !archive ||
      archive.resource_id !== resourceId ||
      (archiveHasWorkerTerminalClosePhase(archive.content) &&
        readWorkerTerminalClosePhase(archive, resource) === 'unknown') ||
      this.workerTerminalResourceHasIdentityConflict(resourceId)
    ) {
      this.db.exec('COMMIT')
      return false
    }
    // Persist before calling the runtime: after a crash, a live PTY does not prove
    // that an earlier close was never issued.
    const content = archiveWithWorkerTerminalClosePhase(archive.content, resource, 'issued')
    this.storeWorkerTerminalArchive({ dispatchId, resourceId, kind: archive.kind, content })
    this.db.exec('COMMIT')
    return true
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/**
 * A late review hold found after the close phase was persisted but before any close was sent.
 * Only an 'issued' phase with unchanged identity rewinds; nothing else can prove no close went out.
 */
export function rewindWorkerTerminalReleaseCloseToPrepared(
  this: OrchestrationDb,
  dispatchId: string,
  resourceId: string
): boolean {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(resourceId)
    const archive = this.getWorkerTerminalArchive(dispatchId)
    if (
      !resource ||
      resource.owner_dispatch_id !== dispatchId ||
      resource.ownership_state !== 'owned' ||
      resource.release_state !== 'releasing' ||
      !archive ||
      archive.resource_id !== resourceId ||
      readWorkerTerminalClosePhase(archive, resource) !== 'issued' ||
      this.workerTerminalResourceHasIdentityConflict(resourceId)
    ) {
      this.db.exec('COMMIT')
      return false
    }
    const content = archiveWithWorkerTerminalClosePhase(archive.content, resource, 'prepared')
    this.storeWorkerTerminalArchive({ dispatchId, resourceId, kind: archive.kind, content })
    this.db.exec('COMMIT')
    return true
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerTerminalClosePhaseMethods = {
  rewindWorkerTerminalReleaseCloseToPrepared: typeof rewindWorkerTerminalReleaseCloseToPrepared
  getWorkerTerminalReleaseClosePhase: typeof getWorkerTerminalReleaseClosePhase
  workerTerminalReleaseCanRetain: typeof workerTerminalReleaseCanRetain
  markWorkerTerminalReleaseCloseIssued: typeof markWorkerTerminalReleaseCloseIssued
}

export function attachWorkerTerminalClosePhase(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getWorkerTerminalReleaseClosePhase,
    workerTerminalReleaseCanRetain,
    markWorkerTerminalReleaseCloseIssued,
    rewindWorkerTerminalReleaseCloseToPrepared
  })
}
