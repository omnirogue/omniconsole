/** A same-host, synchronously revocable lease checked by the process owning the PTY. */
import { runProcessSync } from '../../shared/child-process/run-process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { GuardedWriteReceiver } from './guarded-pty-write'

export type WriteLatchBinding = {
  daemonNonce: string
  sessionId: string
  receiver: GuardedWriteReceiver
}

function processBirth(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isSafeInteger(pid) || pid < 2) {
    return null
  }
  try {
    const result = runProcessSync({
      program: 'ps',
      args: ['-p', String(pid), '-o', 'stat=,lstart='],
      timeoutMs: 1500,
      maxOutputBytes: 4096,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
    })
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return null
    }
    const line = result.stdout.trim()
    const match = /^(\S+)\s+(.+)$/.exec(line)
    return match && !match[1]!.includes('Z') && Number.isFinite(Date.parse(match[2]!))
      ? match[2]!
      : null
  } catch {
    return null
  }
}

function latchPath(tokenPath: string, token: string): string {
  return join(dirname(tokenPath), 'terminal-write-latches', token)
}

/** Keep the fd: revocation can still truncate after the directory is moved or made unwritable. */
export function createWriteLatch(
  tokenPath: string,
  binding: WriteLatchBinding
): {
  token: string
  close: () => void
} {
  const birth = processBirth(process.pid)
  if (!birth) {
    throw new Error('write_latch_owner_unknown')
  }
  const token = randomUUID()
  const path = latchPath(tokenPath, token)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directory = lstatSync(dirname(path))
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.()
  ) {
    throw new Error('write_latch_directory_not_private')
  }
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600)
  let closed = false
  const close = (): void => {
    if (closed) {
      return
    }
    let invalidated = false
    try {
      ftruncateSync(fd, 0)
      invalidated = true
    } catch {
      /* independent unlink fallback below */
    }
    try {
      unlinkSync(path)
      invalidated = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        invalidated = true
      }
    }
    // Throwing cannot stop an in-flight daemon write. End this owner so its leases fail liveness;
    // the daemon and its terminals remain alive for the next app instance to adopt.
    if (!invalidated) {
      process.exit(1)
    }
    closed = true
    try {
      closeSync(fd)
    } catch {
      /* already invalidated; no descriptor can authorize a write */
    }
  }
  try {
    writeFileSync(
      fd,
      JSON.stringify({ ...binding, token, ownerPid: process.pid, ownerBirth: birth })
    )
  } catch (error) {
    close()
    throw error
  }
  return { token, close }
}

/** Called as the final synchronous guard before PTY write. No validity cache is permitted. */
export function isWriteLatchOpen(
  tokenPath: string,
  token: unknown,
  binding: WriteLatchBinding
): boolean {
  if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) {
    return false
  }
  const path = latchPath(tokenPath, token)
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const initial = fstatSync(fd)
    if (
      !initial.isFile() ||
      initial.size < 1 ||
      initial.size > 4096 ||
      (initial.mode & 0o077) !== 0 ||
      initial.uid !== process.getuid?.()
    ) {
      return false
    }
    const record = JSON.parse(readFileSync(fd, 'utf8'))
    if (
      record.token !== token ||
      record.daemonNonce !== binding.daemonNonce ||
      record.sessionId !== binding.sessionId ||
      record.receiver?.pid !== binding.receiver.pid ||
      record.receiver?.pgid !== binding.receiver.pgid ||
      record.receiver?.startTimeMs !== binding.receiver.startTimeMs ||
      typeof record.ownerBirth !== 'string' ||
      processBirth(record.ownerPid) !== record.ownerBirth
    ) {
      return false
    }
    // An open fd survives unlink. Recheck both its size and the linked pathname after the slow ps.
    const current = fstatSync(fd)
    const linked = lstatSync(path)
    return (
      current.size === initial.size &&
      current.nlink === 1 &&
      linked.isFile() &&
      linked.ino === current.ino &&
      linked.dev === current.dev &&
      linked.size === current.size
    )
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}
