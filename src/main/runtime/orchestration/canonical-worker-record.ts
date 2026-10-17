import type { TerminalExitCause } from '../../../shared/terminal-exit-cause'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
  renameSync
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { randomBytes } from 'node:crypto'
import type { CanonicalWorkerExecution } from '../../../shared/canonical-worker-execution'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'

export type CanonicalWorkerRecord = CanonicalWorkerExecution & {
  gateDirectory: string
  gateNonce: string
  bindingHash: string
  launchDigest: string
  runGeneration: number
  rootExit?: { exitCode: number | null; observedAt: string; exitCause?: TerminalExitCause }
  startReceipt?: { attempt_id?: unknown; session_id?: unknown }
}

export function consumeCanonicalWorkerFile(file: string, consume = true): unknown {
  if (!isAbsolute(file)) {
    throw new Error('Canonical worker input must be an absolute local file.')
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.() ||
      info.size > 4 * 1024 * 1024
    ) {
      throw new Error('Canonical worker input must be a private file owned by this execution host.')
    }
    let value: unknown
    try {
      value = JSON.parse(readFileSync(fd, 'utf8'))
    } catch {
      throw new Error('Canonical worker input is not valid JSON.')
    }
    if (consume) {
      unlinkSync(file)
    }
    return value
  } finally {
    closeSync(fd)
  }
}

export function writeCanonicalWorkerFile(file: string, value: unknown): void {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    writeFileSync(fd, JSON.stringify(value))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, file)
  const directory = openSync(join(file, '..'), constants.O_RDONLY)
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

export function readCanonicalWorkerRecord(
  db: OrchestrationDb,
  dispatchId: string
): CanonicalWorkerRecord | null {
  const worker = db.getWorkerDispatch(dispatchId)
  if (!worker) {
    return null
  }
  const options = JSON.parse(worker.start_options) as { canonical?: CanonicalWorkerRecord }
  return options.canonical ?? null
}

export function updateCanonicalWorkerRecord(
  db: OrchestrationDb,
  dispatchId: string,
  changes: Partial<CanonicalWorkerRecord>
): CanonicalWorkerRecord {
  const worker = db.getWorkerDispatch(dispatchId)
  const record = readCanonicalWorkerRecord(db, dispatchId)
  if (!worker || !record) {
    throw new OrchestrationError('dispatch_not_found', 'Canonical worker was not found.')
  }
  const updated = { ...record, ...changes }
  const options = JSON.parse(worker.start_options) as Record<string, unknown>
  db.db
    .prepare(
      "UPDATE worker_dispatches SET start_options = ?, updated_at = datetime('now') WHERE dispatch_id = ?"
    )
    .run(JSON.stringify({ ...options, canonical: updated }), dispatchId)
  return updated
}

export function exposeCanonicalWorker(record: CanonicalWorkerRecord): CanonicalWorkerExecution {
  return {
    binding: record.binding,
    processIdentity: record.processIdentity,
    phase: record.phase,
    terminalProof: record.terminalProof
  }
}

export function assertCanonicalWorkerAck(value: unknown, record: CanonicalWorkerRecord): void {
  const answer = value as { ok?: unknown; job?: Record<string, unknown> } | null
  const job = answer?.job
  const receipt = job?.execution_start_receipt as Record<string, unknown> | undefined
  if (
    answer?.ok !== true ||
    !job ||
    !record.processIdentity ||
    job.id !== record.binding.job_id ||
    job.attempt !== record.binding.attempt ||
    job.claimed_at !== record.binding.claimed_at ||
    job.runner_instance !== record.processIdentity.runner_instance ||
    job.cancel_requested === true ||
    job.terminal_proof ||
    job.status !== 'running' ||
    !isDeepStrictEqual(job.execution_binding, record.binding) ||
    !isDeepStrictEqual(job.process_identity, record.processIdentity) ||
    receipt?.started !== true ||
    !isDeepStrictEqual(receipt.binding, record.binding) ||
    typeof receipt.session_id !== 'string' ||
    !receipt.session_id
  ) {
    throw new OrchestrationError(
      'consumer_fenced',
      'Hub did not acknowledge this exact canonical worker process.'
    )
  }
}
