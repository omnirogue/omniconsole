import { getAppEnvironment } from '../../../shared/app-environment'
import { readTerminalHistoryExactExit } from '../../daemon/terminal-history-exact-exit'
import type { TerminalExitCause } from '../../../shared/terminal-exit-cause'
import { join } from 'node:path'
import { runProcess } from '../../../shared/child-process/run-process'
import { forceTerminatePosixProcessGroup } from '../../../shared/child-process/process-tree-termination'
import type { CanonicalWorkerProcessIdentity } from '../../../shared/canonical-worker-execution'
import type { OrchestrationDb } from './db'
import {
  consumeCanonicalWorkerFile,
  exposeCanonicalWorker,
  readCanonicalWorkerRecord,
  updateCanonicalWorkerRecord
} from './canonical-worker-record'

export type CanonicalGateObservation = CanonicalWorkerProcessIdentity & {
  pgid: number
  binding_hash: string
  phase: 'prepared' | 'released' | 'aborted'
  launch_gate_closed: boolean
}

export function readCanonicalGateObservation(directory: string): CanonicalGateObservation | null {
  try {
    return consumeCanonicalWorkerFile(
      join(directory, 'process.json'),
      false
    ) as CanonicalGateObservation
  } catch {
    return null
  }
}

export async function canonicalProcessBirth(
  identity: CanonicalWorkerProcessIdentity
): Promise<'current' | 'absent' | 'different' | 'unverifiable'> {
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-p', String(identity.pid), '-o', 'lstart='],
      env: { ...process.env, LC_ALL: 'C' },
      timeoutMs: 5000,
      maxOutputBytes: 1024
    })
    if (result.code === 1 && !result.stdout.trim()) {
      return 'absent'
    }
    if (result.code !== 0 || !result.stdout.trim()) {
      return 'unverifiable'
    }
    return result.stdout.trim() === identity.started_at ? 'current' : 'different'
  } catch {
    return 'unverifiable'
  }
}

export async function observeCanonicalProcessIdentity(
  pid: number,
  runnerInstance: string
): Promise<CanonicalWorkerProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('A host-attested process PID is required.')
  }
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-p', String(pid), '-o', 'lstart='],
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: 5000,
    maxOutputBytes: 1024
  })
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error('The execution host could not observe process birth.')
  }
  return { pid, started_at: result.stdout.trim(), runner_instance: runnerInstance }
}

export function recordCanonicalWorkerRootExit(
  db: OrchestrationDb,
  dispatchId: string,
  exitCode: number | null,
  exitCause?: TerminalExitCause,
  observedAt = new Date().toISOString()
): boolean {
  const record = readCanonicalWorkerRecord(db, dispatchId)
  if (!record) {
    return false
  }
  if (!record.rootExit) {
    updateCanonicalWorkerRecord(db, dispatchId, {
      rootExit: { exitCode, observedAt, ...(exitCause ? { exitCause } : {}) }
    })
  }
  if (db.getWorkerDispatch(dispatchId)?.state === 'stopping') {
    return true
  }
  db.db
    .prepare(
      `UPDATE worker_dispatches SET state = CASE WHEN state = 'stop_unknown' THEN 'stopped' ELSE ? END, stage = 'process_exited' WHERE dispatch_id = ? AND state IN ('starting', 'ready', 'start_unknown', 'stop_unknown')`
    )
    .run(exitCode === 0 ? 'succeeded' : 'failed', dispatchId)
  db.db
    .prepare(
      `UPDATE dispatch_contexts SET status = ?, completed_at = COALESCE(completed_at, datetime('now')), capability_revoked_at = COALESCE(capability_revoked_at, datetime('now')) WHERE id = ? AND status IN ('pending', 'dispatched')`
    )
    .run(exitCode === 0 ? 'completed' : 'failed', dispatchId)
  db.db
    .prepare(
      `UPDATE tasks SET status = 'blocked' WHERE id = (SELECT task_id FROM dispatch_contexts WHERE id = ?) AND status = 'dispatched'`
    )
    .run(dispatchId)
  return true
}

/** Attribute an exact host event even before the runtime has rebuilt its terminal surfaces. */
export function recordCanonicalWorkerProcessExit(
  db: OrchestrationDb,
  processIncarnation: string,
  exitCode: number | null,
  exitCause?: TerminalExitCause
): void {
  const dispatches = db.db
    .prepare('SELECT id FROM dispatch_contexts WHERE process_incarnation = ?')
    .all(processIncarnation) as { id: string }[]
  for (const dispatch of dispatches) {
    if (recordCanonicalWorkerRootExit(db, dispatch.id, exitCode, exitCause)) {
      void observeCanonicalWorker(db, dispatch.id).catch(() => undefined)
    }
  }
}

/** Recover only the daemon's committed exit for this exact previously-attested process. */
function recoverCanonicalWorkerRootExit(db: OrchestrationDb, dispatchId: string): void {
  const record = readCanonicalWorkerRecord(db, dispatchId)
  const processIncarnation = db.getDispatchContextById(dispatchId)?.process_incarnation
  if (!record?.processIdentity || record.rootExit || !processIncarnation) {
    return
  }
  const separator = processIncarnation.lastIndexOf(':')
  if (separator <= 0) {
    return
  }
  const sessionId = processIncarnation.slice(0, separator)
  const incarnationId = processIncarnation.slice(separator + 1)
  try {
    const exit = readTerminalHistoryExactExit(
      join(getAppEnvironment().getPath('userData'), 'terminal-history'),
      sessionId,
      incarnationId
    )
    if (exit.status !== 'readable' || exit.observation.pid !== record.processIdentity.pid) {
      return
    }
    recordCanonicalWorkerRootExit(
      db,
      dispatchId,
      exit.observation.exitCode,
      exit.observation.exitCause,
      exit.observation.observedAt
    )
  } catch {
    // Unreadable or unavailable history is uncertainty, never inferred termination.
  }
}

/** A host exit plus group quiescence is evidence; a missing transport is not. */
export async function observeCanonicalWorker(db: OrchestrationDb, dispatchId: string) {
  recoverCanonicalWorkerRootExit(db, dispatchId)
  let record = readCanonicalWorkerRecord(db, dispatchId)
  if (!record) {
    return null
  }
  if (record.terminalProof || !record.processIdentity || !record.rootExit) {
    return exposeCanonicalWorker(record)
  }
  const identity = record.processIdentity
  const birth = await canonicalProcessBirth(identity)
  if (birth !== 'absent') {
    return exposeCanonicalWorker(record)
  }
  if (!(await forceTerminatePosixProcessGroup(identity.pid))) {
    return exposeCanonicalWorker(record)
  }
  record = readCanonicalWorkerRecord(db, dispatchId)!
  if (!record.terminalProof) {
    const cause = record.rootExit!.exitCause
    if (cause?.kind === 'unknown') {
      return exposeCanonicalWorker(record)
    }
    const closed = record.phase === 'prepared'
    record = updateCanonicalWorkerRecord(db, dispatchId, {
      phase: 'exited',
      terminalProof: {
        kind: closed ? 'not_started' : 'exited',
        process_identity: identity,
        process_exited: true,
        exit_code: record.rootExit!.exitCode,
        ...(cause
          ? {
              process_exit_code: record.rootExit!.exitCode,
              exit_cause:
                cause.kind === 'exited'
                  ? { kind: 'exited' as const, exit_code: cause.exitCode }
                  : cause
            }
          : {}),
        observed_at: new Date().toISOString(),
        ...(closed ? { launch_gate_closed: true as const } : {})
      }
    })
  }
  return exposeCanonicalWorker(record)
}
