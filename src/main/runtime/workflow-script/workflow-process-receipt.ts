import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { join, resolve } from 'node:path'
import type { ProcessResult } from '../../../shared/child-process/process-spec'
import type { WorkflowTerminalReceipt } from './workflow-durable-call'
import { workflowEvidenceDigest } from './workflow-evidence-digest'

import {
  assertWorkflowProcessReceiptIdentity,
  type WorkflowProcessReceiptIdentity
} from './workflow-process-receipt-identity'
export type { WorkflowProcessReceiptIdentity } from './workflow-process-receipt-identity'

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) {
    throw new Error('Workflow process receipt is unverifiable')
  }
}

function readBoundedFile(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    requireEvidence(stat.isFile() && stat.size <= limit)
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null)
      if (count === 0) {
        break
      }
      size += count
    }
    requireEvidence(size <= limit)
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function processResult(value: unknown, maxOutputBytes: number): ProcessResult {
  requireEvidence(value && typeof value === 'object')
  const result = value as ProcessResult & { stalledAfterMs?: number }
  requireEvidence(
    (result.code === null || (Number.isSafeInteger(result.code) && result.code >= 0)) &&
      (result.signal === null || Object.hasOwn(osConstants.signals, result.signal)) &&
      typeof result.stdout === 'string' &&
      typeof result.stderr === 'string' &&
      typeof result.timedOut === 'boolean' &&
      (result.stdoutTruncated === undefined || result.stdoutTruncated === true) &&
      (result.stderrTruncated === undefined || result.stderrTruncated === true) &&
      (result.stalledAfterMs === undefined ||
        (Number.isSafeInteger(result.stalledAfterMs) && result.stalledAfterMs > 0)) &&
      Buffer.byteLength(result.stdout) <= maxOutputBytes &&
      Buffer.byteLength(result.stderr) <= maxOutputBytes
  )
  return result
}

/** A launch receipt that matches the attempt's prepared identity: who launched which process. */
export type WorkflowLaunchReceipt = {
  attemptDirectory: string
  launchJson: string
  pid: number
  launchedAt: number
}

/**
 * The launch half of the evidence, without the terminal receipt. Alone it proves only that a
 * process was started; it never establishes exit or permission to respawn.
 */
export function readWorkflowLaunchReceipt(
  expected: WorkflowProcessReceiptIdentity
): WorkflowLaunchReceipt {
  assertWorkflowProcessReceiptIdentity(expected)
  const root = realpathSync(expected.directory)
  const attemptDirectory = join(root, expected.attemptId)
  requireEvidence(realpathSync(attemptDirectory) === attemptDirectory)
  const launchJson = readBoundedFile(join(attemptDirectory, 'launch.json'), 64 * 1024)
  const launch = JSON.parse(launchJson)
  requireEvidence(launch && typeof launch === 'object')
  requireEvidence(
    launch.version === 2 &&
      launch.hostId === expected.hostId &&
      launch.ownerIncarnation === expected.ownerIncarnation &&
      launch.platform === process.platform &&
      launch.executionId === expected.executionId &&
      launch.fence === expected.fence &&
      launch.attemptId === expected.attemptId &&
      launch.callId === expected.callId &&
      launch.ordinal === expected.ordinal &&
      launch.commandDigest === expected.commandDigest &&
      launch.inputDigest === expected.inputDigest &&
      Number.isSafeInteger(launch.pid) &&
      launch.pid > 0 &&
      launch.processGroupId === launch.pid &&
      Number.isSafeInteger(launch.ownerPid) &&
      launch.ownerPid > 0 &&
      typeof launch.launchedAt === 'string' &&
      Number.isFinite(Date.parse(launch.launchedAt))
  )
  return {
    attemptDirectory,
    launchJson,
    pid: launch.pid,
    launchedAt: Date.parse(launch.launchedAt)
  }
}

/** Missing evidence never establishes exit or permission to respawn. Caller supplies host identity. */
export function readWorkflowProcessReceipt(expected: WorkflowProcessReceiptIdentity): {
  result: ProcessResult
  receipt: WorkflowTerminalReceipt
  launchedAt: number
  exitedAt: number
} {
  const { attemptDirectory, launchJson, launchedAt } = readWorkflowLaunchReceipt(expected)
  const terminal = JSON.parse(
    readBoundedFile(
      join(attemptDirectory, 'terminal.json'),
      expected.maxOutputBytes * 12 + 64 * 1024
    )
  )
  requireEvidence(terminal && typeof terminal === 'object')
  requireEvidence(
    terminal.executionId === expected.executionId &&
      terminal.fence === expected.fence &&
      terminal.attemptId === expected.attemptId &&
      typeof terminal.exitedAt === 'string' &&
      Number.isFinite(Date.parse(terminal.exitedAt)) &&
      terminal.liveness === 'exited' &&
      typeof terminal.groupCleanupRequired === 'boolean' &&
      terminal.launchDigest === workflowEvidenceDigest(launchJson) &&
      terminal.processReceiptRef === join(expected.directory, expected.attemptId, 'launch.json') &&
      resolve(terminal.processReceiptRef) ===
        resolve(expected.directory, expected.attemptId, 'launch.json')
  )
  const result = processResult(terminal.result, expected.maxOutputBytes)
  requireEvidence(terminal.resultDigest === workflowEvidenceDigest(JSON.stringify(result)))
  return {
    result,
    launchedAt,
    exitedAt: Date.parse(terminal.exitedAt),
    receipt: {
      attemptId: expected.attemptId,
      processReceiptRef: terminal.processReceiptRef,
      liveness: 'exited'
    }
  }
}
