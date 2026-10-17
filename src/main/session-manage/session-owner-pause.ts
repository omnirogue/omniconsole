import type { SessionOwnerPauseResult } from '../../shared/session-owner-pause'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import {
  stopSession,
  type SessionControlDeps,
  type SessionControlTarget
} from './session-manage-control'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'

export const PAUSE_SOURCE_CHANGED =
  'The selected conversation or turn changed. Inspect it before pausing again.'

/** The owner decides idle; archive placement and a stale renderer status grant no stop authority. */
export async function pauseOwnedTerminal(
  deps: SessionControlDeps,
  target: SessionControlTarget,
  stillCurrent: () => boolean,
  sameConversation: () => boolean = stillCurrent
): Promise<SessionOwnerPauseResult> {
  let keepGoingStopped = false
  let interruptAttempted = false
  const assertCurrent = () => {
    if (!stillCurrent()) {
      throw new SessionManageRefusal(PAUSE_SOURCE_CHANGED)
    }
  }
  try {
    assertCurrent()
    const { entry } = target
    if (entry.verdict !== 'live' || !['idle', 'working', 'queued'].includes(entry.state)) {
      throw new SessionManageRefusal(
        'This session is not confirmed idle or working on its execution host. Nothing was paused.'
      )
    }
    const result = await stopSession(
      {
        ...deps,
        stopKeepGoing: (source) => {
          assertCurrent()
          keepGoingStopped = deps.stopKeepGoing(
            source,
            'You paused this conversation from the sidebar.'
          )
          return keepGoingStopped
        },
        interrupt: async (handle, receiver, source) => {
          assertCurrent()
          interruptAttempted = true
          await deps.interrupt(handle, receiver, source)
        }
      },
      { actor: { kind: 'cli' }, target, force: false, dryRun: false }
    )
    if (interruptAttempted && target.agentProcess && entry.terminal) {
      let confirmed = false
      const deadline = deps.now() + 5_000
      for (let waited = 0; waited <= 5_000; waited += 250) {
        const remaining = deadline - deps.now()
        if (remaining <= 0 || !sameConversation()) {
          break
        }
        const working = await withTimeout(
          deps.stillWorking(entry.terminal, target.agentProcess),
          remaining,
          true
        )
        if (!working && sameConversation()) {
          confirmed = true
          break
        }
        if (waited < 5_000) {
          await deps.sleep(Math.min(250, Math.max(0, deadline - deps.now())))
        }
      }
      if (!confirmed) {
        throw new SessionManagePartialError(
          'The pause was requested but the same agent has not confirmed an idle prompt. Inspect it before retrying.',
          `one interrupt was dispatched${keepGoingStopped ? ' and Keep going was turned off' : ''}`
        )
      }
    }
    return {
      state: entry.state === 'working' || keepGoingStopped ? 'paused' : 'already-idle',
      message: result.summary,
      keepGoingStopped,
      queuedPrompts: entry.queueLength
    }
  } catch (error) {
    return {
      state:
        !keepGoingStopped &&
        !interruptAttempted &&
        error instanceof SessionManageRefusal &&
        error.message === PAUSE_SOURCE_CHANGED
          ? 'source-changed'
          : 'unverifiable',
      message: error instanceof Error ? error.message : 'The pause could not be verified.',
      ...(keepGoingStopped ? { keepGoingStopped: true } : {}),
      ...(error instanceof SessionManagePartialError || interruptAttempted
        ? { queuedPrompts: target.entry.queueLength }
        : {})
    }
  }
}
