import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertWorkflowProcessReceiptIdentity,
  type WorkflowProcessReceiptIdentity
} from './workflow-process-receipt-identity'

const LAUNCH_RECEIPT_LIMIT = 64 * 1024

function readLaunchJson(path: string): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    return stat.isFile() && stat.size <= LAUNCH_RECEIPT_LIMIT ? readFileSync(fd, 'utf8') : undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * When a still-running attempt's process started, from its launch receipt (written before the
 * attempt is marked running). Display only: it must match the attempt's prepared identity, and
 * it is never used to accept, settle or respawn anything. Unreadable evidence has no time.
 */
export function readWorkflowLaunchedAt(
  expected: WorkflowProcessReceiptIdentity
): number | undefined {
  try {
    assertWorkflowProcessReceiptIdentity(expected)
    const directory = join(realpathSync(expected.directory), expected.attemptId)
    if (realpathSync(directory) !== directory) {
      return undefined
    }
    const text = readLaunchJson(join(directory, 'launch.json'))
    const launch = text ? JSON.parse(text) : undefined
    if (
      !launch ||
      launch.version !== 2 ||
      launch.hostId !== expected.hostId ||
      launch.executionId !== expected.executionId ||
      launch.fence !== expected.fence ||
      launch.attemptId !== expected.attemptId ||
      launch.callId !== expected.callId ||
      launch.ordinal !== expected.ordinal ||
      launch.commandDigest !== expected.commandDigest ||
      launch.inputDigest !== expected.inputDigest ||
      typeof launch.launchedAt !== 'string'
    ) {
      return undefined
    }
    const launchedAt = Date.parse(launch.launchedAt)
    return Number.isFinite(launchedAt) ? launchedAt : undefined
  } catch {
    return undefined
  }
}
