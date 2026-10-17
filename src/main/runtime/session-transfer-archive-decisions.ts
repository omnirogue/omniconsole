import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import type { TransferArchiveProjection } from '../../shared/session-folder-cli-channels'

type Decision = TransferArchiveProjection & { scope: string; applied: boolean }
const directory = () => join(getProfileUserDataPath(), 'session-transfer-archives-v1')
const filename = (operationId: string) =>
  join(directory(), `${createHash('sha256').update(operationId).digest('hex')}.json`)

export function validArchiveProjectionScope(scope: unknown): scope is string {
  return (
    typeof scope === 'string' &&
    scope.startsWith('omni.session-sidebar-view.v1:') &&
    scope.length <= 8192
  )
}

function read(file: string): Decision {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Decision
  if (
    !value.operationId ||
    !validArchiveProjectionScope(value.scope) ||
    !Array.isArray(value.keys) ||
    !value.keys.length ||
    value.keys.some((key) => typeof key !== 'string' || !key) ||
    typeof value.applied !== 'boolean'
  ) {
    throw new Error('Invalid archive decision')
  }
  return value
}

/** No yield between the final source guard and the authoritative durable decision. */
function save(decision: Decision, guard: () => boolean): boolean {
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  const temporary = join(directory(), `.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(decision))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    if (!guard()) {
      return false
    }
    renameSync(temporary, filename(decision.operationId))
    // The renamed decision must survive process restart before main acknowledges it.
    const dirFd = process.platform === 'win32' ? undefined : openSync(directory(), 'r')
    if (dirFd !== undefined) {
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    }
    return true
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
    if (existsSync(temporary)) {
      unlinkSync(temporary)
    }
  }
}

export function commitArchiveDecision(
  operationId: string,
  keys: readonly string[],
  scope: string,
  guard: () => boolean
): boolean {
  if (
    !validArchiveProjectionScope(scope) ||
    !operationId ||
    !keys.length ||
    new Set(keys).size !== keys.length
  ) {
    return false
  }
  // Operation IDs are never repeated, even after the projection was acknowledged.
  if (existsSync(filename(operationId))) {
    return false
  }
  return save({ operationId, keys: [...keys], scope, applied: false }, guard)
}

export function pendingArchiveDecisions(scope: string): TransferArchiveProjection[] {
  if (!validArchiveProjectionScope(scope) || !existsSync(directory())) {
    return []
  }
  return readdirSync(directory())
    .filter((name) => name.endsWith('.json'))
    .map((name) => read(join(directory(), name)))
    .filter((value) => value.scope === scope && !value.applied)
    .map(({ operationId, keys }) => ({ operationId, keys }))
}

export function acknowledgeArchiveDecision(scope: string, operationId: string): boolean {
  if (!validArchiveProjectionScope(scope) || !operationId || !existsSync(filename(operationId))) {
    return false
  }
  const value = read(filename(operationId))
  if (value.scope !== scope) {
    return false
  }
  return value.applied || save({ ...value, applied: true }, () => true)
}
