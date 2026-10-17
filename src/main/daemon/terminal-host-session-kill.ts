import type { Session } from './session'
import type { TerminalSessionTeardown } from './terminal-session-teardown'
import type { TerminalHostTombstones } from './terminal-host-tombstones'
import { SessionNotFoundError } from './types'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { TerminalHostOptions } from './terminal-host-options'

/** Longer than node-pty's post-waitpid socket drain, so a child that just exited
 *  normally still reports its own exit (and tail output) before we synthesize one. */
export const PROCESS_GONE_EXIT_GRACE_MS = 1_000

// Why unknown: the OS proved the process is gone, but nobody observed how it ended.
const PROCESS_GONE_EXIT_CAUSE: TerminalExitCause = {
  kind: 'unknown',
  reason: 'host_status_unavailable'
}

export type TerminalHostProcessGoneOptions = Pick<
  TerminalHostOptions,
  'isProcessGone' | 'onSessionProcessGone' | 'processGoneExitGraceMs'
>

/**
 * Kill routing for TerminalHost, plus the one recovery the normal exit path cannot
 * provide: a session whose child is already gone but whose exit callback never fired
 * (#843). Such a session stayed `isAlive` forever, every kill on it failed with ESRCH,
 * and main re-materialised it as an empty terminal on each inventory. Here a positive
 * process-gone probe finishes the session through its own exit path instead.
 */
export class TerminalHostSessionKill {
  private readonly settling = new Map<Session, Promise<void>>()

  constructor(
    private readonly options: TerminalHostProcessGoneOptions,
    private readonly sessions: ReadonlyMap<string, Session>,
    private readonly sessionTeardown: TerminalSessionTeardown,
    private readonly killedTombstones: TerminalHostTombstones
  ) {}

  kill(sessionId: string, opts: { immediate?: boolean }): Promise<void> {
    const { sessionTeardown, killedTombstones } = this
    const pending = sessionTeardown.get(sessionId)
    if (pending) {
      return Promise.resolve(opts.immediate ? sessionTeardown.requestImmediate(sessionId) : pending)
    }
    const session = this.sessions.get(sessionId)
    if (!session || !session.isAlive) {
      throw new SessionNotFoundError(sessionId)
    }
    // Why before any signal: a gone pid is eligible for POSIX reuse; never aim a kill at it.
    if (this.isProcessGone(session)) {
      killedTombstones.record(sessionId)
      return this.settleProcessGone(sessionId, session)
    }
    let killed: void | Promise<void>
    try {
      killed = sessionTeardown.killSession(sessionId, session, opts.immediate === true)
    } catch (error) {
      if (!this.isProcessGone(session)) {
        throw error
      }
      killed = this.settleProcessGone(sessionId, session)
    }
    killedTombstones.record(sessionId)
    // Why: without a probe, hand back the teardown's own promise so joined kills stay identical.
    if (!this.options.isProcessGone) {
      return Promise.resolve(killed)
    }
    return Promise.resolve(killed).catch((error: unknown) => {
      // Why: ESRCH from the force-kill is proof of death, not failure; a live child still rethrows.
      if (!session.isAlive || !this.isProcessGone(session)) {
        throw error
      }
      return this.settleProcessGone(sessionId, session)
    })
  }

  /** Listing filter: a live-state session whose process is gone is never reported,
   *  and is finished through the exit path once the grace window passes. */
  isListable = (session: Session): boolean => {
    if (!this.isProcessGone(session)) {
      return true
    }
    void this.settleProcessGone(session.sessionId, session)
    return false
  }

  private isProcessGone(session: Session): boolean {
    return session.isAlive && this.options.isProcessGone?.(session.pid) === true
  }

  private settleProcessGone(sessionId: string, session: Session): Promise<void> {
    const existing = this.settling.get(session)
    if (existing) {
      return existing
    }
    const graceMs = this.options.processGoneExitGraceMs ?? PROCESS_GONE_EXIT_GRACE_MS
    const settled = new Promise<void>((resolve) => {
      setTimeout(resolve, graceMs).unref?.()
    }).then(() => {
      this.settling.delete(session)
      // Why: the real exit may have landed during the grace window; it already reaped.
      if (!session.isAlive) {
        return
      }
      const pid = session.pid
      // Same path as a natural exit: exit fan-out, owner release, dispose, registry delete.
      session.handleSubprocessExit(-1, PROCESS_GONE_EXIT_CAUSE)
      this.options.onSessionProcessGone?.(sessionId, pid)
    })
    this.settling.set(session, settled)
    return settled
  }
}
