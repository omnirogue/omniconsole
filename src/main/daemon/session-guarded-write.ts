/**
 * The daemon's half of a guarded write (`guarded-pty-write.ts`): the check runs here, in the process
 * that owns the PTY, synchronously with the write. Sessions keep their subprocess private, so the
 * creator registers it; a session whose shell is not ready yet refuses rather than jump its input.
 *
 * Fenced writes (`conversation-write-fence.ts` in main) also carry their fence's token: main pushes
 * each revocation here, and every write under a revoked token is refused at the moment of writing.
 */

import {
  isGuardedWriteReceiver,
  type GuardedWriteCheck,
  type GuardedWriteOutcome
} from '../pty/guarded-pty-write'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { Session } from './session'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { TerminalHost } from './terminal-host'
import { isWriteLatchOpen } from '../pty/terminal-write-latch'

const subprocesses = new WeakMap<Session, SubprocessHandle>()
// Why bounded: a token lives for one delivery; thousands of revocations never overlap one.
const MAX_REVOKED_FENCES = 4_096
const revokedFences = new Set<string>()

export function registerSessionSubprocess(session: Session, subprocess: SubprocessHandle): void {
  subprocesses.set(session, subprocess)
}

export function guardedSessionWrite(
  session: Pick<Session, 'isAlive' | 'shellState'>,
  data: string,
  check: GuardedWriteCheck
): GuardedWriteOutcome {
  const subprocess = subprocesses.get(session as Session)
  if (!subprocess?.guardedWrite) {
    return 'unsupported'
  }
  return session.isAlive && session.shellState !== 'pending'
    ? subprocess.guardedWrite(data, check)
    : 'refused'
}

export type GuardedWriteRequestPayload = {
  sessionId: string
  data: string
  receiver: unknown
  fenceToken?: unknown
}

/** The router's `fencedWrite`: an unknown or ended session is refused, never written through. */
export function routeGuardedWrite(
  options: {
    host: Pick<TerminalHost, 'guardedWrite'>
    attachments: Pick<DaemonSessionAttachments, 'recordInput'>
  },
  payload: GuardedWriteRequestPayload
): { outcome: GuardedWriteOutcome } {
  const token = payload.fenceToken
  if (token !== undefined) {
    return { outcome: 'unsupported' }
  }
  if (
    typeof payload.sessionId !== 'string' ||
    typeof payload.data !== 'string' ||
    !isGuardedWriteReceiver(payload.receiver) ||
    (token !== undefined && (typeof token !== 'string' || !token))
  ) {
    return { outcome: 'refused' }
  }
  if (token !== undefined && revokedFences.has(token)) {
    return { outcome: 'revoked' }
  }
  const outcome = options.host.guardedWrite(payload.sessionId, payload.data, {
    receiver: payload.receiver,
    ...(token !== undefined ? { fenceRevoked: () => revokedFences.has(token) } : {})
  })
  if (outcome === 'written') {
    options.attachments.recordInput(payload.sessionId)
  }
  return { outcome }
}

/** The router's `revokeWriteFence`: from now on, no write under this token. */
export function routeRevokeWriteFence(payload: { token: unknown }): { revoked: boolean } {
  if (typeof payload.token !== 'string' || !payload.token) {
    return { revoked: false }
  }
  revokedFences.add(payload.token)
  if (revokedFences.size > MAX_REVOKED_FENCES) {
    revokedFences.delete(revokedFences.values().next().value!)
  }
  return { revoked: true }
}

/** Check the owner-visible latch at the writer, after all queued/awaited work. */
export function routeLatchedWrite(
  options: {
    tokenPath: string
    daemonNonce: string | null
    host: Pick<TerminalHost, 'guardedWrite'>
    attachments: Pick<DaemonSessionAttachments, 'recordInput'>
  },
  payload: Omit<GuardedWriteRequestPayload, 'fenceToken'> & { latchToken: unknown }
): { outcome: GuardedWriteOutcome } {
  if (
    !options.daemonNonce ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.data !== 'string' ||
    !isGuardedWriteReceiver(payload.receiver)
  ) {
    return { outcome: 'refused' }
  }
  const binding = {
    daemonNonce: options.daemonNonce,
    sessionId: payload.sessionId,
    receiver: payload.receiver
  }
  const fenceRevoked = () => !isWriteLatchOpen(options.tokenPath, payload.latchToken, binding)
  if (fenceRevoked()) {
    return { outcome: 'revoked' }
  }
  const outcome = options.host.guardedWrite(payload.sessionId, payload.data, {
    receiver: payload.receiver,
    fenceRevoked
  })
  if (outcome === 'written') {
    options.attachments.recordInput(payload.sessionId)
  }
  return { outcome }
}
