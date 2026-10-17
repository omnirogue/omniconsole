import { BuildReviewRpcError, type OrchestrationCaller } from './build-review-rpc-call'
import {
  claudeStartupDialogOnScreen,
  startupScreenBottom
} from '../rpc/methods/orchestration-worker-startup-screen'
import {
  CancelledError,
  type ActiveRun,
  type WorkerHostContext
} from './build-review-worker-lifecycle'
import type { WorkerUnitLike } from './build-review-worker-registry'

/** Startup questions a person answers in the worker's own terminal; the run waits for them. */
const ANSWERABLE_BLOCKERS = new Set([
  'claude-folder-trust',
  'codex-trust-workspace',
  'codex-hooks-review-prompt',
  'codex-update-prompt',
  'codex-cwd-prompt',
  'codex-model-migration-prompt',
  'codex-interactive-prompt'
])

// Codex's startup questions all end on the key that answers them. Why only that, and only at the
// bottom of the screen: a banner such as "Update available" asks nothing, and an answered
// question is gone from the bottom even where its words stay higher up.
const QUESTION_AT_BOTTOM =
  /press enter to (?:confirm|continue)|press t to trust|do you trust the contents of this directory/i

const GONE_TERMINAL_CODES = new Set(['terminal_handle_stale', 'terminal_gone', 'terminal_exited'])
/** A worker asked more than this many times is not being helped by waiting. */
const MAX_ANSWERS_PER_WORKER = 3
/** Reads in a row that must agree before the wait decides: a redraw or a probe can blink. */
const READS_TO_DECIDE = 2

export type StartupWaitTiming = {
  pollMs: number
  /** How long a question may wait for its person before the start fails as it used to. */
  timeoutMs: number
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export type StartupWaitOutcome = 'answered' | 'declined' | 'closed' | 'timed-out' | 'cancelled'

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Why removed on both paths: an hour of polls must not leave a listener per poll behind.
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

export const DEFAULT_STARTUP_WAIT_TIMING: StartupWaitTiming = {
  pollMs: 2_000,
  timeoutMs: 60 * 60_000,
  now: Date.now,
  sleep: abortableSleep
}

export function isAnswerableStartupBlocker(blocker: string | undefined): boolean {
  return blocker !== undefined && ANSWERABLE_BLOCKERS.has(blocker)
}

type ScreenRead = { terminal?: { tail?: unknown; source?: string; status?: string } }
type ScreenState = 'prompt' | 'clear' | 'unknown' | 'closed'

function startupQuestionOnScreen(tail: readonly unknown[]): boolean {
  return (
    claudeStartupDialogOnScreen(tail) !== null || QUESTION_AT_BOTTOM.test(startupScreenBottom(tail))
  )
}

async function screenState(call: OrchestrationCaller, handle: string): Promise<ScreenState> {
  try {
    const read = await call<ScreenRead>('terminal.read', {
      terminal: handle,
      limit: 60,
      screen: true
    })
    const terminal = read.terminal
    // Why the status: the runtime keeps an exited worker terminal readable, so a read after
    // "Stop and Close" still answers, with no screen to show.
    if (terminal?.status === 'exited') {
      return 'closed'
    }
    // Why only the rendered screen: a stream keeps the answered question in its scrollback.
    if (terminal?.source !== 'screen' || !Array.isArray(terminal.tail)) {
      return 'unknown'
    }
    return startupQuestionOnScreen(terminal.tail) ? 'prompt' : 'clear'
  } catch (error) {
    return error instanceof BuildReviewRpcError && GONE_TERMINAL_CODES.has(error.code)
      ? 'closed'
      : 'unknown'
  }
}

async function agentRunning(
  call: OrchestrationCaller,
  handle: string
): Promise<boolean | undefined> {
  try {
    const shown = await call<{ isRunningAgent?: boolean }>('terminal.isRunningAgent', {
      terminal: handle
    })
    return shown.isRunningAgent === true
  } catch {
    return undefined
  }
}

/**
 * Wait until the person answers the startup question in the worker's terminal: the question is
 * gone from its screen on two reads in a row (a dialog redrawing reads empty for a moment) while
 * the agent still runs there. The agent gone on two reads in a row means it did not start, even
 * where its dialog is still drawn above the shell it exited to.
 */
export async function waitForStartupAnswer(
  call: OrchestrationCaller,
  handle: string,
  signal: AbortSignal,
  timing: StartupWaitTiming = DEFAULT_STARTUP_WAIT_TIMING
): Promise<StartupWaitOutcome> {
  const deadline = timing.now() + timing.timeoutMs
  let clearReads = 0
  let goneReads = 0
  while (timing.now() < deadline) {
    if (signal.aborted) {
      return 'cancelled'
    }
    const state = await screenState(call, handle)
    if (state === 'closed') {
      return 'closed'
    }
    const running = await agentRunning(call, handle)
    goneReads = running === false ? goneReads + 1 : 0
    if (goneReads >= READS_TO_DECIDE) {
      return 'declined'
    }
    clearReads = state === 'clear' ? clearReads + 1 : 0
    if (clearReads >= READS_TO_DECIDE && running === true) {
      return 'answered'
    }
    await timing.sleep(timing.pollMs, signal)
  }
  return signal.aborted ? 'cancelled' : 'timed-out'
}

/** A start that ended at its question for good: say why in words, not that it still asks. */
function noteQuestionEnded(worker: WorkerUnitLike, outcome: 'declined' | 'closed'): void {
  worker.status = 'failed'
  worker.startupBlocker = undefined
  // Why here: the keeper only watches terminals a workspace hold names, so it never sees this one.
  if (outcome === 'closed') {
    worker.terminalClosed = true
  }
  worker.error =
    outcome === 'closed'
      ? 'Its terminal was closed before the startup question was answered.'
      : 'The agent exited at its startup question, so it did not start.'
}

/**
 * Build + Review's answer to a start that stopped on a question the person can answer: keep the
 * worker waiting on them with its terminal open, instead of failing the run and asking for a
 * Retry. True once answered, so the worker starts again in that same terminal.
 */
export function buildReviewStartupAnswerWait(
  call: OrchestrationCaller,
  timing: StartupWaitTiming = DEFAULT_STARTUP_WAIT_TIMING
): (worker: WorkerUnitLike, host: WorkerHostContext, run: ActiveRun) => Promise<boolean> {
  const asked = new WeakMap<WorkerUnitLike, number>()
  return async (worker, host, run) => {
    const handle = worker.terminalHandle
    const count = asked.get(worker) ?? 0
    if (!handle || !isAnswerableStartupBlocker(worker.startupBlocker)) {
      return false
    }
    if (count >= MAX_ANSWERS_PER_WORKER) {
      return false
    }
    // Why seen first: a question the screen cannot show is one nobody can tell was answered,
    // so that start fails as before and its terminal stays open for the person and a Retry.
    const state = await screenState(call, handle)
    if (state === 'closed') {
      noteQuestionEnded(worker, 'closed')
    } else if (state === 'clear' && (await agentRunning(call, handle)) === false) {
      noteQuestionEnded(worker, 'declined')
    }
    if (state !== 'prompt') {
      return false
    }
    asked.set(worker, count + 1)
    const failure = worker.error
    worker.status = 'starting'
    worker.error = null
    host.log('info', worker.role, 'Waiting for you to answer it in its terminal')
    host.changed()
    const outcome = await waitForStartupAnswer(call, handle, run.abort.signal, timing)
    if (outcome === 'answered') {
      worker.startupBlocker = undefined
      // Why running: its agent is up in that terminal; the handover can take minutes of it working.
      worker.status = 'running'
      host.log('info', worker.role, 'Answered; starting it again in the same terminal')
      host.changed()
      return true
    }
    if (outcome === 'declined' || outcome === 'closed') {
      noteQuestionEnded(worker, outcome)
      return false
    }
    worker.status = 'failed'
    worker.error = failure
    if (outcome === 'cancelled') {
      throw new CancelledError()
    }
    return false
  }
}
