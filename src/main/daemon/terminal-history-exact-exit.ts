import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  parseTerminalStreamSnapshot,
  type TerminalStreamSnapshot
} from '../../shared/terminal-stream'
import { getHistorySessionDirName } from './history-paths'

export type TerminalHistoryExactExit = {
  version: 1
  sessionId: string
  incarnationId: string
  pid: number
  observedAt: string
  exitCause: TerminalExitCause
  exitCode: number | null
  terminalStream?: TerminalStreamSnapshot
}

export type TerminalHistoryExactExitRead =
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'readable'; observation: TerminalHistoryExactExit }

// Two bounded text windows can expand sixfold when JSON escapes control characters.
const MAX_EXIT_BYTES = 4 * 1024 * 1024

export function readTerminalHistoryExactExit(
  basePath: string,
  sessionId: string,
  incarnationId: string
): TerminalHistoryExactExitRead {
  let fd: number | undefined
  try {
    const { directory, file } = exitPaths(basePath, sessionId, incarnationId)
    assertOwnedDirectory(basePath)
    assertOwnedDirectory(directory)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      !Number.isSafeInteger(info.size) ||
      info.size < 0 ||
      info.size > MAX_EXIT_BYTES
    ) {
      return { status: 'unreadable' }
    }
    const content = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < content.length) {
      const read = readSync(fd, content, length, content.length - length, null)
      if (read === 0) {
        break
      }
      length += read
    }
    if (length !== info.size) {
      return { status: 'unreadable' }
    }
    const observation = parseObservation(JSON.parse(content.subarray(0, length).toString('utf8')))
    if (
      !observation ||
      observation.sessionId !== sessionId ||
      observation.incarnationId !== incarnationId
    ) {
      return { status: 'unreadable' }
    }
    return { status: 'readable', observation }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable' }
  } finally {
    if (fd !== undefined) {
      closeBestEffort(fd)
    }
  }
}

export function writeTerminalHistoryExactExit(
  basePath: string,
  value: TerminalHistoryExactExit
): boolean {
  if (process.platform === 'win32') {
    return false
  }
  let temporary: string | undefined
  let fd: number | undefined
  const directories: number[] = []
  try {
    const observation = parseObservation(value)
    if (!observation) {
      return false
    }
    const { directory, file } = exitPaths(
      basePath,
      observation.sessionId,
      observation.incarnationId
    )
    mkdirSync(basePath, { recursive: true, mode: 0o700 })
    assertOwnedDirectory(basePath)
    mkdirSync(directory, { mode: 0o700, recursive: true })
    assertOwnedDirectory(directory)
    for (const path of [directory, basePath, dirname(basePath)]) {
      const directoryFd = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      )
      directories.push(directoryFd)
      // Fail before publication when the filesystem cannot persist directory entries.
      fsyncSync(directoryFd)
    }
    const content = JSON.stringify(observation)
    if (Buffer.byteLength(content) > MAX_EXIT_BYTES) {
      return false
    }
    temporary = join(directory, `.exact-exit-${randomBytes(16).toString('hex')}.tmp`)
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    try {
      linkSync(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
      const existing = readTerminalHistoryExactExit(
        basePath,
        observation.sessionId,
        observation.incarnationId
      )
      if (existing.status !== 'readable' || !isDeepStrictEqual(existing.observation, observation)) {
        return false
      }
    }
    unlinkSync(temporary)
    temporary = undefined
    for (const directoryFd of directories) {
      fsyncSync(directoryFd)
    }
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      closeBestEffort(fd)
    }
    if (temporary) {
      try {
        unlinkSync(temporary)
      } catch {
        /* Failed publication remains unconfirmed. */
      }
    }
    for (const directoryFd of directories) {
      closeBestEffort(directoryFd)
    }
  }
}

function closeBestEffort(fd: number): void {
  try {
    closeSync(fd)
  } catch {
    // Cleanup must not replace the recorded read or publication outcome.
  }
}

function exitPaths(basePath: string, sessionId: string, incarnationId: string) {
  if (
    !isAbsolute(basePath) ||
    !validIdentity(sessionId) ||
    sessionId === '.' ||
    sessionId === '..' ||
    !isPtyIncarnationId(incarnationId) ||
    !validIdentity(incarnationId)
  ) {
    throw new Error('Invalid terminal history exit identity.')
  }
  const directory = join(basePath, getHistorySessionDirName(sessionId))
  const hash = createHash('sha256').update(incarnationId).digest('hex')
  return { directory, file: join(directory, `exact-exit-${hash}.json`) }
}

function assertOwnedDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) {
    throw new Error('Terminal history requires an owned directory.')
  }
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    Buffer.from(value).toString('utf8') === value
  )
}

function parseObservation(value: unknown): TerminalHistoryExactExit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    !validIdentity(record.sessionId) ||
    !isPtyIncarnationId(record.incarnationId) ||
    !validIdentity(record.incarnationId) ||
    !Number.isSafeInteger(record.pid) ||
    Number(record.pid) <= 0 ||
    typeof record.observedAt !== 'string' ||
    record.observedAt.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(record.observedAt) ||
    !Number.isFinite(Date.parse(record.observedAt)) ||
    new Date(record.observedAt).toISOString().slice(0, 19) !== record.observedAt.slice(0, 19)
  ) {
    return null
  }
  const cause = parseExitCause(record.exitCause)
  if (!cause || record.exitCode !== (cause.kind === 'exited' ? cause.exitCode : null)) {
    return null
  }
  const terminalStream =
    record.terminalStream === undefined
      ? undefined
      : parseTerminalStreamSnapshot(record.terminalStream)
  if (terminalStream === null) {
    return null
  }
  return {
    version: 1,
    sessionId: record.sessionId,
    incarnationId: record.incarnationId,
    pid: Number(record.pid),
    observedAt: record.observedAt,
    exitCause: cause,
    exitCode: cause.kind === 'exited' ? cause.exitCode : null,
    ...(terminalStream === undefined ? {} : { terminalStream })
  }
}

function parseExitCause(value: unknown): TerminalExitCause | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const cause = value as Record<string, unknown>
  if (
    cause.kind === 'exited' &&
    Number.isSafeInteger(cause.exitCode) &&
    Number(cause.exitCode) >= 0
  ) {
    return { kind: 'exited', exitCode: Number(cause.exitCode) }
  }
  if (cause.kind === 'signaled' && Number.isSafeInteger(cause.signal) && Number(cause.signal) > 0) {
    return { kind: 'signaled', signal: Number(cause.signal) }
  }
  if (cause.kind === 'operator_close') {
    return { kind: 'operator_close' }
  }
  if (
    cause.kind === 'unknown' &&
    (cause.reason === 'cause_unreported' || cause.reason === 'host_status_unavailable')
  ) {
    return { kind: 'unknown', reason: cause.reason }
  }
  return null
}
