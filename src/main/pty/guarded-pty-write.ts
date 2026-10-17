/**
 * A write that reaches only the receiver it was bound to: `omni session continue|ask` prompts. The
 * owning PTY (node-pty in main, or in the terminal daemon) checks, synchronously and immediately
 * before each write, that the bound process (pid, start time) still leads the process group that
 * holds this tty's foreground; anything else (a shell after Ctrl-Z, a replacement program, a
 * platform without the check) is refused.
 */

import { isShellProcess } from '../../shared/shell-process-detection'
import {
  PS_LSTART_TOLERANCE_MS,
  readPosixReceiverRowSync,
  type PosixReceiverRow
} from './posix-pty-foreground-group'

export type GuardedWriteOutcome = 'written' | 'refused' | 'unsupported' | 'revoked' | 'unknown'

/** The process a guarded write may reach, as proven when the prompt was bound. */
export type GuardedWriteReceiver = { pid: number; pgid: number; startTimeMs: number }

/** A fenced write's conversation fence (`conversation-write-fence.ts`), as main hands it down. */
export type WriteFence = {
  token: string
  isRevoked: () => boolean
  onClose?: (invalidate: () => void) => () => void
}

/** What the owning writer checks before one write: its receiver and, if fenced, its fence. */
export type GuardedWriteCheck = { receiver: GuardedWriteReceiver; fenceRevoked?: () => boolean }

export const GUARDED_WRITE_RECEIVER_CHANGED =
  'The agent it was queued for no longer holds its terminal, so the prompt was not sent.'
export const GUARDED_WRITE_FENCE_REVOKED =
  'Its conversation changed while the prompt was being written, so it was not sent.'
export const GUARDED_WRITE_UNSUPPORTED =
  'This terminal cannot enforce every prompt guard at the moment of writing, so nothing was sent. Send it yourself in the target session.'

export function isGuardedWriteReceiver(value: unknown): value is GuardedWriteReceiver {
  const receiver = value as GuardedWriteReceiver | null
  return (
    typeof receiver === 'object' &&
    receiver !== null &&
    Number.isSafeInteger(receiver.pid) &&
    receiver.pid > 1 &&
    Number.isSafeInteger(receiver.pgid) &&
    receiver.pgid > 1 &&
    Number.isFinite(receiver.startTimeMs)
  )
}

function quietly<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

function normalizeTty(value: string): string {
  return value.replace(/^\/dev\//, '')
}

export function guardedPtyWrite(input: {
  ptsName: string | undefined
  receiver: GuardedWriteReceiver
  /** Synchronous: the fence this write is under was revoked (a conversation change). */
  fenceRevoked?: () => boolean
  /** The foreground group leader's name via tcgetpgrp(2) on the master (node-pty `.process`). */
  readLeaderName: () => string | undefined
  write: () => void
  platform?: NodeJS.Platform
  readReceiver?: (pid: number) => PosixReceiverRow | null
}): GuardedWriteOutcome {
  const { ptsName, receiver } = input
  if ((input.platform ?? process.platform) === 'win32' || !ptsName) {
    return 'unsupported'
  }
  const before = quietly(input.readLeaderName)
  const row = quietly(() => (input.readReceiver ?? readPosixReceiverRowSync)(receiver.pid))
  const holds =
    row !== null &&
    normalizeTty(row.tty) === normalizeTty(ptsName) &&
    row.pgid === receiver.pgid &&
    row.tpgid === receiver.pgid &&
    row.startTimeMs !== null &&
    // Why a margin at all: both sides read the same `lstart` field, whose last digit is seconds.
    Math.abs(row.startTimeMs - receiver.startTimeMs) <= PS_LSTART_TOLERANCE_MS
  if (!holds) {
    return 'refused'
  }
  if (quietly(() => input.fenceRevoked?.() ?? false) !== false) {
    return 'revoked'
  }
  const leader = quietly(input.readLeaderName)
  // Why a second tcgetpgrp right before the write: the process read above takes milliseconds. What
  // stays is the kernel's own window between this read and the line discipline taking the bytes,
  // which no user-space check can close.
  if (!leader || leader !== before || isShellProcess(leader)) {
    return 'refused'
  }
  input.write()
  return 'written'
}
