import { realpathSync } from 'node:fs'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { OrchestrationDb } from '../orchestration/db/orchestration-db'
import {
  BuildReviewWorkspaceHeldError,
  missingDispatchEvidence,
  readBuildReviewReservation,
  unresolvedBuildReviewDispatches,
  type BuildReviewReservation as Reservation
} from './build-review-workspace-evidence'

export function buildReviewWorkspaceKey(workspace: { path: string; hostId?: string }): string {
  const host = workspace.hostId ?? 'local'
  const path = normalizeRuntimePathForComparison(
    host === 'local' ? realpathSync(workspace.path) : workspace.path
  )
  return JSON.stringify([host, path])
}

export function ownerDefinitelyGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/** What the reserving run no longer holds, found by reconciliation after the fact. */
export type BuildReviewClaimOptions = {
  /** Dispatches whose worker settled and whose terminal is provably gone. */
  resolved?: ReadonlySet<string>
  /**
   * The previous owner is this runtime and its pipeline is no longer executing, so its process
   * being alive (it is this one) says nothing about its workers.
   */
  ownerSettled?: boolean
}

function stillUnresolved(
  db: OrchestrationDb,
  runId: string | null,
  resolved: ReadonlySet<string> | undefined
) {
  return unresolvedBuildReviewDispatches(db, runId).filter((entry) => !resolved?.has(entry.id))
}

export function claimBuildReviewWorkspace(
  db: OrchestrationDb,
  workspaceKey: string,
  worktreeId: string,
  pipelineId: string,
  runtimeEpoch: string,
  ownerPid = process.pid,
  options: BuildReviewClaimOptions = {}
): void {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const previous = readBuildReviewReservation(db, workspaceKey)
    if (previous) {
      const unresolved = stillUnresolved(db, previous.run_id, options.resolved)
      const missingEvidence = missingDispatchEvidence(db, previous)
      const ownerLive = !options.ownerSettled && !ownerDefinitelyGone(previous.owner_pid)
      if (ownerLive || missingEvidence || unresolved.length > 0) {
        throw new BuildReviewWorkspaceHeldError(previous, unresolved, missingEvidence, ownerLive)
      }
      db.db
        .prepare('DELETE FROM build_review_workspace_reservations WHERE workspace_key = ?')
        .run(workspaceKey)
    }
    db.db
      .prepare(
        `INSERT INTO build_review_workspace_reservations
         (workspace_key, worktree_id, pipeline_id, runtime_epoch, owner_pid)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(workspaceKey, worktreeId, pipelineId, runtimeEpoch, ownerPid)
    db.db.exec('COMMIT')
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

export function markBuildReviewWorkerStart(
  db: OrchestrationDb,
  workspaceKey: string,
  pipelineId: string,
  runtimeEpoch: string
): void {
  const updated = db.db
    .prepare(
      `UPDATE build_review_workspace_reservations SET worker_start_in_flight = 1
       WHERE workspace_key = ? AND pipeline_id = ? AND runtime_epoch = ?
         AND run_id IS NOT NULL AND worker_start_in_flight = 0`
    )
    .run(workspaceKey, pipelineId, runtimeEpoch)
  if (updated.changes !== 1) {
    throw new Error('Build + Review lost its workspace reservation before worker start.')
  }
}

export function recordBuildReviewWorkerStart(
  db: OrchestrationDb,
  workspaceKey: string,
  pipelineId: string,
  runtimeEpoch: string,
  dispatchId: string
): void {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.db
      .prepare(
        `SELECT * FROM build_review_workspace_reservations
         WHERE workspace_key = ? AND pipeline_id = ? AND runtime_epoch = ?`
      )
      .get(workspaceKey, pipelineId, runtimeEpoch) as Reservation | undefined
    if (!row || row.worker_start_in_flight !== 1 || !row.run_id) {
      throw new Error('Build + Review lost its in-flight worker reservation.')
    }
    const dispatch = db.db
      .prepare('SELECT run_id FROM dispatch_contexts WHERE id = ?')
      .get(dispatchId) as { run_id: string } | undefined
    if (dispatch?.run_id !== row.run_id) {
      throw new Error(`Build + Review Dispatch ${dispatchId} is missing from its Run.`)
    }
    const ids = JSON.parse(row.worker_dispatch_ids) as string[]
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new Error('Build + Review worker Dispatch history is invalid.')
    }
    ids.push(dispatchId)
    db.db
      .prepare(
        `UPDATE build_review_workspace_reservations
         SET worker_dispatch_ids = ?, worker_start_in_flight = 0
         WHERE workspace_key = ? AND pipeline_id = ? AND runtime_epoch = ?`
      )
      .run(JSON.stringify(ids), workspaceKey, pipelineId, runtimeEpoch)
    db.db.exec('COMMIT')
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

export function clearRejectedBuildReviewWorkerStart(
  db: OrchestrationDb,
  workspaceKey: string,
  pipelineId: string,
  runtimeEpoch: string
): void {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.db
      .prepare(
        `SELECT * FROM build_review_workspace_reservations
         WHERE workspace_key = ? AND pipeline_id = ? AND runtime_epoch = ?`
      )
      .get(workspaceKey, pipelineId, runtimeEpoch) as Reservation | undefined
    if (!row?.run_id || row.worker_start_in_flight !== 1) {
      db.db.exec('COMMIT')
      return
    }
    const ids = JSON.parse(row.worker_dispatch_ids) as unknown
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      db.db.exec('COMMIT')
      return
    }
    const actual = db.db
      .prepare('SELECT id FROM dispatch_contexts WHERE run_id = ?')
      .all(row.run_id) as { id: string }[]
    if (actual.length !== ids.length || actual.some(({ id }) => !ids.includes(id))) {
      db.db.exec('COMMIT')
      return
    }
    db.db
      .prepare(
        `UPDATE build_review_workspace_reservations SET worker_start_in_flight = 0
         WHERE workspace_key = ? AND pipeline_id = ? AND runtime_epoch = ?
           AND worker_start_in_flight = 1`
      )
      .run(workspaceKey, pipelineId, runtimeEpoch)
    db.db.exec('COMMIT')
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}

export function bindBuildReviewRun(
  db: OrchestrationDb,
  workspaceKey: string,
  pipelineId: string,
  runtimeEpoch: string,
  runId: string
): void {
  const updated = db.db
    .prepare(
      `UPDATE build_review_workspace_reservations SET run_id = ?
       WHERE workspace_key = ? AND pipeline_id = ? AND runtime_epoch = ?`
    )
    .run(runId, workspaceKey, pipelineId, runtimeEpoch)
  if (updated.changes !== 1) {
    throw new Error('Build + Review lost its workspace reservation before worker dispatch.')
  }
}

/** Keep the reservation when a worker or its owned terminal remains unresolved. */
export function releaseBuildReviewWorkspace(
  db: OrchestrationDb,
  workspaceKey: string,
  pipelineId: string,
  runtimeEpoch: string,
  resolved?: ReadonlySet<string>
): boolean {
  db.db.exec('BEGIN IMMEDIATE')
  try {
    const current = readBuildReviewReservation(db, workspaceKey)
    if (!current || current.pipeline_id !== pipelineId || current.runtime_epoch !== runtimeEpoch) {
      db.db.exec('COMMIT')
      return false
    }
    if (
      missingDispatchEvidence(db, current) ||
      stillUnresolved(db, current.run_id, resolved).length > 0
    ) {
      db.db.exec('COMMIT')
      return false
    }
    db.db
      .prepare('DELETE FROM build_review_workspace_reservations WHERE workspace_key = ?')
      .run(workspaceKey)
    db.db.exec('COMMIT')
    return true
  } catch (error) {
    db.db.exec('ROLLBACK')
    throw error
  }
}
