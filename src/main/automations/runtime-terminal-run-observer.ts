import {
  closeOwnedAutomationRunTerminal,
  type AutomationPaneCloseHost
} from './failed-pane-cleanup'
import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'
import type {
  AutomationRunCompletionObservation,
  AutomationRunTerminalObserver
} from './run-completion-watcher'
import type { AutomationRunOutputSnapshot } from '../../shared/automations-types'
import { describeDeadAutomationTerminal } from '../../shared/automation-terminal-chrome'
import { isSessionAttemptApprovalStartupBlocker } from '../../shared/session-attempt-recovery'
import {
  readBoundAutomationRunObservation,
  readCurrentAutomationRunTurnEnd,
  type AutomationRunHookEvidence
} from './runtime-terminal-run-turn-evidence'

const TERMINAL_SNAPSHOT_LIMIT = 2_000

/** Cadence for re-probing a pane that already satisfied tui-idle at dispatch. */
const AGENT_START_POLL_INTERVAL_MS = 250
const RETAINED_RUN_POLL_INTERVAL_MS = 2_000
/** Kept under the runtime's 2s tui-idle fallback poll so a probe waiter is torn
 *  down before it can start a foreground-process poll of its own. */
const AGENT_START_PROBE_TIMEOUT_MS = 250
/** Fast startup probing window; after it, unknown start backs off rather than
 *  claiming the run failed. A restart may have missed the real working edge. */
const AGENT_START_DEADLINE_MS = 2 * 60 * 1000
/** Total observation budget. Each tui-idle wait expires on the runtime's own
 *  5-minute schedule and a live agent legitimately outlives many of them, so the
 *  bound is wall-clock and generous; it exists so a pane whose agent is never
 *  detected stops re-arming for the process lifetime with its run stuck at
 *  `dispatched`. Startup reconciliation re-attaches, so this is not a hard cap on
 *  how long a surviving run may be watched across restarts. */
const OBSERVE_DEADLINE_MS = 6 * 60 * 60 * 1000

/** The runtime surface an authority uses to observe its own terminals. */
export type AutomationRunTerminalHost = AutomationPaneCloseHost & {
  getTerminalHandleForPaneKey(paneKey: string): string | null
  getTerminalProcessIncarnation?(handle: string): string | null
  getFreshAgentHookStatusForHandle?(handle: string): AutomationRunHookEvidence | null
  getTerminalAgentStatus?(
    handle: string
  ): Promise<{ isRunningAgent: boolean; status: 'working' | 'permission' | 'idle' | null }>
  waitForTerminal(
    handle: string,
    options?: { condition?: 'tui-idle'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ satisfied: boolean; blockedReason?: string }>
  readTerminal(handle: string, opts?: { limit?: number }): Promise<{ tail: string[] }>
}

function isTerminalWaitTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout'
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('request_aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('request_aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Whether tui-idle is satisfiable from evidence the pane holds RIGHT NOW.
 *  Why a real wait with a short timeout rather than a status read: the runtime
 *  satisfies tui-idle from a sticky agent status, an idle pane title, or a ready
 *  shell prompt, across two different code shapes (pty vs leaf). Asking it the
 *  question it already answers keeps every one of those in scope. */
async function isTuiIdleSatisfiedNow(
  runtime: AutomationRunTerminalHost,
  handle: string,
  signal: AbortSignal
): Promise<boolean> {
  try {
    const wait = await runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: AGENT_START_PROBE_TIMEOUT_MS,
      signal
    })
    if (wait.satisfied && runtime.getTerminalAgentStatus) {
      const agent = await runtime.getTerminalAgentStatus(handle)
      return agent.isRunningAgent && agent.status === 'idle'
    }
    // A blocked pane is not "already finished"; let the real wait report it.
    return wait.satisfied
  } catch (error) {
    if (isTerminalWaitTimeout(error)) {
      return false
    }
    throw error
  }
}

async function readTerminalSnapshot(
  runtime: AutomationRunTerminalHost,
  handle: string
): Promise<AutomationRunOutputSnapshot | null> {
  const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
  try {
    const read = await runtime.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })
    snapshotBuffer.append(read.tail.join('\n'))
  } catch {
    // Why: the terminal can exit between the wait resolving and the tail read;
    // a missing snapshot must not turn a satisfied wait into a failure.
  }
  return snapshotBuffer.snapshot()
}

/** A hook that has neither finished cleanly nor failed: working, waiting on permission, or a
 *  session-boundary "done" that marks a launch connect rather than a completed turn. */
function hookStillRunning(runtime: AutomationRunTerminalHost, handle: string): boolean {
  const hook = runtime.getFreshAgentHookStatusForHandle?.(handle)
  if (!hook || hook.failed || hook.interrupted) {
    return false
  }
  return hook.state !== 'done' || hook.sessionBoundary === true
}

async function buildObservation(
  runtime: AutomationRunTerminalHost,
  handle: string,
  wait: { satisfied: boolean; blockedReason?: string }
): Promise<AutomationRunCompletionObservation | null> {
  const outputSnapshot = await readTerminalSnapshot(runtime, handle)
  // Why: a Codex pane refusing to resume ("open in another app · R to Retry") reads as
  // idle with no hook, which the hook-less branch below would call completed — measured
  // 2026-09-20, two APPLY runs recorded as completed while the pauses never ran.
  const dead = outputSnapshot ? describeDeadAutomationTerminal(outputSnapshot.content) : null
  if (dead) {
    return { status: 'dispatch_failed', outputSnapshot, error: dead }
  }
  const hook = runtime.getFreshAgentHookStatusForHandle?.(handle)
  if (hook?.failed || hook?.interrupted) {
    return {
      status: 'dispatch_failed',
      outputSnapshot,
      error:
        hook.failureReason ??
        (hook.interrupted
          ? 'The automation was cancelled.'
          : 'The agent stopped without finishing.')
    }
  }
  // Hook-less providers retain the existing working-to-idle completion signal.
  if (wait.satisfied && (!hook || (hook.state === 'done' && !hook.sessionBoundary))) {
    return { status: 'completed', outputSnapshot, error: null }
  }
  if (!wait.satisfied && isSessionAttemptApprovalStartupBlocker(wait.blockedReason)) {
    // This worker can resume in place; a supported question does not settle the routine.
    return null
  }
  return {
    status: 'dispatch_failed',
    outputSnapshot,
    error: wait.blockedReason
      ? `Automation agent is blocked: ${wait.blockedReason}.`
      : 'Automation agent did not report completion.'
  }
}

export function createRuntimeAutomationRunTerminalObserver(
  runtime: AutomationRunTerminalHost
): AutomationRunTerminalObserver {
  return {
    captureTerminalProcessIncarnation: (run) => {
      if (!run.terminalPaneKey || !run.terminalPtyId) {
        return null
      }
      try {
        const handle = runtime.getTerminalHandleForPaneKey(run.terminalPaneKey)
        const incarnation = handle ? runtime.getTerminalProcessIncarnation?.(handle) : null
        // Exclude the getter's restart-degraded legacy fallback: it is not an
        // execution owner's durable PTY incarnation.
        return incarnation?.startsWith(`${run.terminalPtyId}:`) ? incarnation : null
      } catch {
        return null
      }
    },
    closeRunTerminal: (run) => closeOwnedAutomationRunTerminal(runtime, run),
    resolveRunTerminal: (run) =>
      run.terminalPaneKey ? runtime.getTerminalHandleForPaneKey(run.terminalPaneKey) : null,
    observeCompletion: async (handle, { signal, readCurrentRun }) => {
      const startedAt = Date.now()
      const deadlineAt = startedAt + OBSERVE_DEADLINE_MS
      const pollInterval = (): number =>
        Date.now() < startedAt + AGENT_START_DEADLINE_MS
          ? AGENT_START_POLL_INTERVAL_MS
          : RETAINED_RUN_POLL_INTERVAL_MS
      const readTurnEnd = (): Promise<AutomationRunCompletionObservation | null> =>
        readCurrentAutomationRunTurnEnd({
          runtime,
          handle,
          readCurrentRun,
          readSnapshot: () => readTerminalSnapshot(runtime, handle)
        })
      const currentTurnEnd = await readTurnEnd()
      if (currentTurnEnd) {
        return currentTurnEnd
      }
      // Why: tui-idle is level-triggered, so a reused pane still idle from the
      // PREVIOUS run satisfies it before this run's agent has typed a character.
      // Evidence that predates dispatch proves nothing about this run, so require
      // the pane to leave that state first — the busy edge the renderer's own
      // dispatch observer requires on reuse (requireWorkingAfterStart).
      const initialAgent = await runtime.getTerminalAgentStatus?.(handle)
      if (
        initialAgent
          ? !(initialAgent.isRunningAgent && initialAgent.status === 'working')
          : await isTuiIdleSatisfiedNow(runtime, handle, signal)
      ) {
        for (;;) {
          const turnEnd = await readTurnEnd()
          if (turnEnd) {
            return turnEnd
          }
          if (Date.now() >= deadlineAt) {
            return null
          }
          await sleep(pollInterval(), signal)
          if (runtime.getTerminalAgentStatus) {
            const agent = await runtime.getTerminalAgentStatus(handle)
            if (
              agent.isRunningAgent &&
              (agent.status === 'working' || agent.status === 'permission')
            ) {
              break
            }
          } else if (!(await isTuiIdleSatisfiedNow(runtime, handle, signal))) {
            break
          }
        }
      }
      for (;;) {
        try {
          const turnEnd = await readTurnEnd()
          if (turnEnd) {
            return turnEnd
          }
          if (Date.now() >= deadlineAt) {
            return null
          }
          const wait = await runtime.waitForTerminal(handle, { condition: 'tui-idle', signal })
          // A ready input prompt can remain visible while Codex is working.
          // Confirm idle with the existing live status probe before closing the run.
          if (wait.satisfied && runtime.getTerminalAgentStatus) {
            const agent = await runtime.getTerminalAgentStatus(handle)
            if (!agent.isRunningAgent || agent.status !== 'idle') {
              if (Date.now() >= deadlineAt) {
                return null
              }
              await sleep(pollInterval(), signal)
              continue
            }
          }
          // Why: the screen probe is a heuristic (Codex keeps a ready prompt visible while it
          // works) and the hook is the truth. An idle-looking pane whose hook still says the
          // agent is working, or has only crossed a session boundary, is a run in progress —
          // measured 2026-09-19 on a reused Advertising routine pane, where this branch closed
          // the run as failed 4s after the prompt while the report was still being written.
          if (wait.satisfied && hookStillRunning(runtime, handle)) {
            if (Date.now() >= deadlineAt) {
              return null
            }
            await sleep(pollInterval(), signal)
            continue
          }
          const current = readCurrentRun?.()
          const hook = runtime.getFreshAgentHookStatusForHandle?.(handle)
          // A busy edge remains sufficient for legacy/OSC providers. If a hook
          // carries a turn timestamp or provider identity, however, it must not
          // belong to a previous dispatch merely because the screen looks idle.
          if (
            current &&
            hook &&
            ((typeof hook.stateStartedAt === 'number' &&
              typeof current.dispatchedAt === 'number' &&
              hook.stateStartedAt < current.dispatchedAt) ||
              (hook.providerSession &&
                current.providerSessionId &&
                hook.providerSession.id !== current.providerSessionId))
          ) {
            await sleep(pollInterval(), signal)
            continue
          }
          const expectedHook = JSON.stringify(hook ?? null)
          const observation = await readBoundAutomationRunObservation({
            runtime,
            handle,
            readCurrentRun,
            unchangedEvidence: () =>
              JSON.stringify(runtime.getFreshAgentHookStatusForHandle?.(handle) ?? null) ===
              expectedHook,
            readObservation: () => buildObservation(runtime, handle, wait)
          })
          if (observation) {
            return observation
          }
          await sleep(pollInterval(), signal)
        } catch (error) {
          // Why: tui-idle waits expire on their own schedule; an agent still
          // working past that window is live, so re-arm rather than fail it.
          if (signal.aborted || !isTerminalWaitTimeout(error)) {
            throw error
          }
          if (Date.now() >= deadlineAt) {
            return null
          }
        }
      }
    }
  }
}
