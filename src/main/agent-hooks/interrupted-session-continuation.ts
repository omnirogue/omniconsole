import { createHash } from 'node:crypto'
import { mkdirSync, openSync, closeSync, fsyncSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { syncDirectorySync } from '../durable-file-write'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { agentProviderSessionsEqual } from '../../shared/agent-session-resume'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'

export const INTERRUPTION_CONTINUATION =
  'OmniConsole restarted while you were mid-task (app/daemon restart or reboot). Check what already completed before repeating anything — especially external or irreversible actions (deploys, merges, ad/budget changes, payments, messages) — then continue the task from where you left off.'

/** Claims precede delivery: an ambiguous crash can lose a message, never repeat it. */
export function claimInterruptedTurn(directory: string, key: string): boolean {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, createHash('sha256').update(key).digest('hex'))
  let fd: number
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw error
  }
  try {
    writeSync(fd, 'claimed\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectorySync(directory)
  return true
}

type LiveHook = AgentHookEventPayload

type Options = {
  previous: AgentStatusIpcPayload | undefined
  launchToken: string
  enabled: () => boolean
  claim: (key: string) => boolean
  send: (beforeWrite: () => void) => Promise<unknown>
  record: (outcome: 'submitted' | 'suppressed', error?: unknown) => void
}

export function createInterruptedSessionContinuation(options: Options): {
  observe: (event: LiveHook) => void
  commit: (resumeSucceeded: boolean) => void
  cancel: () => void
} {
  const { previous } = options
  let cancelled =
    previous?.state !== 'working' || previous.providerSessionOnly === true || !options.enabled()
  let committed = false
  let ready = false
  let sending = false
  let claimed = false
  const key = JSON.stringify([
    previous?.paneKey,
    previous?.connectionId,
    previous?.agentType,
    previous?.providerSession?.key,
    previous?.providerSession?.id,
    previous?.stateStartedAt
  ])
  const flush = (): void => {
    if (cancelled || sending || !committed || !ready || !options.enabled()) {
      return
    }
    sending = true
    void options
      .send(() => {
        if (cancelled || !options.enabled() || (!claimed && !options.claim(key))) {
          throw new Error('interrupted_continuation_suppressed')
        }
        claimed = true
      })
      .then(
        () => options.record('submitted'),
        (error: unknown) => options.record('suppressed', error)
      )
  }
  return {
    observe(event) {
      if (cancelled || !previous || event.paneKey !== previous.paneKey) {
        return
      }
      if (event.isReplay || event.restoredUnconfirmed) {
        return
      }
      if (event.launchToken !== options.launchToken) {
        return
      }
      if (
        event.connectionId !== previous.connectionId ||
        event.payload.agentType !== previous.agentType ||
        !agentProviderSessionsEqual(
          previous.agentType,
          event.providerSession,
          previous.providerSession
        )
      ) {
        cancelled = true
        return
      }
      // Only startup boundaries prove readiness; tools/turn-end/permission events cannot.
      ready =
        (event.hookEventName === 'SessionStart' && event.payload.sessionBoundary === true) ||
        (event.hookEventName === 'session_start' && event.providerSessionOnly === true)
      if (!ready) {
        cancelled = true
      }
      flush()
    },
    commit(resumeSucceeded) {
      if (!resumeSucceeded) {
        cancelled = true
      }
      committed = resumeSucceeded
      flush()
    },
    cancel() {
      cancelled = true
    }
  }
}
