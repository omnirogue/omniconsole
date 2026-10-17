import { captureSummary } from '@/lib/session-follow-up-generated-files'
export { summaryFile } from '@/lib/session-follow-up-generated-files'
import {
  createTerminalWaitDependencies,
  SourceSessionFailedError,
  waitForSourceSessionStop
} from '@/lib/next-session-launch'
import { readConversationFleetTranscript } from '@/lib/conversation-fleet-transcript-reader'
import {
  chainAbortError,
  waitForPaneAgentWorking,
  withResolveRetry,
  workspaceRuntimeTarget
} from '@/lib/session-chain-support'
import {
  captureFollowUpFiles,
  errorText,
  FollowUpException,
  resolveFollowUpFiles,
  type FollowUpHostIo
} from '@/lib/session-follow-up-delivery'
import type { FollowUpStepState } from '@/lib/session-follow-up-step-state'
import type { ExactHandoffFile } from '../../../shared/console-handoff-contract'
import type { SessionChain } from '../../../shared/session-chain-types'
import {
  sessionFollowUpNeedsConfirmedFinish,
  type SessionFollowUpRule
} from '../../../shared/session-follow-up-rule'

/**
 * When a saved follow-up may capture: the session stopped and its run is finished.
 * A stop at the prompt only ends one turn, so it counts as finished only with the
 * run's own manifest, a host-observed clean exit, or the person's confirmation.
 */

// Why: between stops nothing is polled; each slice re-arms one store subscription and one host wait.
const NEXT_RUN_SLICE_MS = 10 * 60 * 1000

type Stop = { handle: string; exited: boolean }

function paneWaits(chain: SessionChain, sourcePaneKey: string, signal: AbortSignal) {
  return createTerminalWaitDependencies(
    workspaceRuntimeTarget(chain.worktreeId),
    { sourcePaneKey, worktreeId: chain.worktreeId },
    signal
  )
}

function withoutStopMarks(rule: SessionFollowUpRule): SessionFollowUpRule {
  const { waitingForFiles: _missing, readyAt: _ready, ...rest } = rule
  return rest
}

/** Any of the panes working again is the next run; a fan-out re-arms on its first branch. */
async function waitForNextRun(paneKeys: readonly string[], signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const working = await Promise.race(
      paneKeys.map((paneKey) => waitForPaneAgentWorking(paneKey, signal, NEXT_RUN_SLICE_MS))
    )
    if (working) {
      return
    }
  }
  throw chainAbortError()
}

/** Every pane's next stop; the first pane's handle stands for the run, exited only when all exited. */
async function waitForStops(
  state: FollowUpStepState,
  sourcePaneKeys: readonly string[],
  signal: AbortSignal
): Promise<Stop> {
  // Why: one branch failing ends the others' waits; nothing keeps polling for a step that stopped.
  const local = new AbortController()
  const stopLocal = (): void => local.abort()
  signal.addEventListener('abort', stopLocal)
  try {
    const stops = await Promise.all(
      sourcePaneKeys.map(async (key) => {
        try {
          return await waitForStop(state, key, local.signal)
        } catch (error) {
          local.abort()
          throw error
        }
      })
    )
    const first = stops[0]
    if (!first) {
      throw chainAbortError()
    }
    return { handle: first.handle, exited: stops.every((stop) => stop.exited) }
  } finally {
    signal.removeEventListener('abort', stopLocal)
  }
}

/** The session's next stop. A wait with no verdict is shown and re-checked, never read as a failed run. */
async function waitForStop(
  state: FollowUpStepState,
  sourcePaneKey: string,
  signal: AbortSignal
): Promise<Stop> {
  for (let attempt = 0; ; attempt += 1) {
    const current = state.live()
    if (!current) {
      throw chainAbortError()
    }
    state.mark('waiting')
    try {
      const deps = withResolveRetry(paneWaits(current.chain, sourcePaneKey, signal), signal)
      const stop = await waitForSourceSessionStop(deps, signal)
      return { handle: stop.source.handle, exited: stop.exited }
    } catch (error) {
      if (signal.aborted) {
        throw chainAbortError()
      }
      if (error instanceof SourceSessionFailedError) {
        throw new FollowUpException('run-failed', '', error.message)
      }
      if (!(await state.whileHostOffline())) {
        await state.whileUnverifiable(errorText(error), attempt)
      }
    }
  }
}

/** A host-observed exit of the stopped session; null when it is still running or cannot say. */
async function watchForExit(
  chain: SessionChain,
  sourcePaneKey: string,
  handle: string,
  signal: AbortSignal
): Promise<'exited' | null> {
  let wait
  try {
    wait = await paneWaits(chain, sourcePaneKey, signal).waitForExit(handle, NEXT_RUN_SLICE_MS)
  } catch {
    // Why: a timeout or lost contact is not an exit; the next turn or a confirmation still decides.
    return null
  }
  if (wait.status !== 'exited') {
    return null
  }
  if (wait.exitCode !== 0) {
    throw new FollowUpException(
      'run-failed',
      '',
      `The source session exited with code ${wait.exitCode ?? 'unknown'}.`
    )
  }
  return 'exited'
}

/** Every named file is present at a stop: wait for the next turn or a clean exit, whichever comes first. */
async function waitWhileReady(
  chain: SessionChain,
  sourcePaneKey: string,
  handle: string,
  signal: AbortSignal
): Promise<'working' | 'exited'> {
  while (!signal.aborted) {
    const slice = new AbortController()
    const stop = (): void => slice.abort()
    signal.addEventListener('abort', stop)
    try {
      const outcome = await new Promise<'working' | 'exited' | null>((resolve, reject) => {
        let open = 2
        const settle = (value: 'working' | 'exited' | null): void => {
          open -= 1
          if (value || open === 0) {
            resolve(value)
          }
        }
        void waitForPaneAgentWorking(sourcePaneKey, slice.signal, NEXT_RUN_SLICE_MS).then(
          (working) => settle(working ? 'working' : null)
        )
        watchForExit(chain, sourcePaneKey, handle, slice.signal).then(settle, reject)
      })
      if (outcome) {
        return outcome
      }
    } finally {
      slice.abort()
      signal.removeEventListener('abort', stop)
    }
  }
  throw chainAbortError()
}

/** A file read that waits out a known-offline SSH host; null means "check again". */
export async function whileReadable<T>(
  state: FollowUpStepState,
  read: () => Promise<T>
): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof FollowUpException && error.code !== 'host-unreachable') {
      throw error
    }
    if (await state.whileHostOffline()) {
      return null
    }
    throw error instanceof FollowUpException
      ? error
      : new FollowUpException('unreadable', '', errorText(error))
  }
}

/** Wait for a finished run with every deliverable present, then capture its exact bytes once. */
export async function waitAndCapture(
  state: FollowUpStepState,
  io: FollowUpHostIo,
  sourcePaneKeys: readonly string[],
  signal: AbortSignal,
  /** A stop the runner already observed (a fan-out member after its sibling), used for the first pass. */
  initialStop?: Stop
): Promise<Map<string, ExactHandoffFile>> {
  const sourcePaneKey = sourcePaneKeys[0]
  if (!sourcePaneKey) {
    throw chainAbortError()
  }
  let stop: Stop | null = initialStop ?? null
  for (;;) {
    stop ??= await waitForStops(state, sourcePaneKeys, signal)
    const current = state.live()
    if (!current) {
      throw chainAbortError()
    }
    const rule = current.step.handoff
    const found = await whileReadable(state, () =>
      resolveFollowUpFiles(rule, current.chain.workspacePath, io)
    )
    if (!found) {
      stop = null
      continue
    }
    if (found.missing.length > 0) {
      await state.save(
        { ...withoutStopMarks(rule), waitingForFiles: found.missing },
        { state: 'waiting' }
      )
      await waitForNextRun(sourcePaneKeys, signal)
      stop = null
      continue
    }
    if (
      !stop.exited &&
      rule.confirmedAt === undefined &&
      sessionFollowUpNeedsConfirmedFinish(rule)
    ) {
      await state.save(
        { ...withoutStopMarks(rule), readyAt: rule.readyAt ?? Date.now() },
        { state: 'waiting' }
      )
      const end = await waitWhileReady(current.chain, sourcePaneKey, stop.handle, signal)
      if (end === 'exited') {
        // Why: files are checked again after the exit; the exit itself is the finish.
        stop = { handle: stop.handle, exited: true }
        continue
      }
      const latest = state.live()?.step.handoff
      if (!latest) {
        throw chainAbortError()
      }
      await state.save(withoutStopMarks(latest), { state: 'waiting' })
      stop = null
      continue
    }
    const summary = rule.includeSummary
      ? await captureSummary(current.chain, rule, sourcePaneKey, stop.handle, signal)
      : null
    const transcript = rule.transcriptSource
      ? await readConversationFleetTranscript(
          rule.transcriptSource,
          new Date().toISOString(),
          signal,
          true
        )
      : null
    if (transcript?.kind === 'refused') {
      throw new FollowUpException('unreadable', rule.sessionLabel, transcript.message)
    }
    const capture = await whileReadable(state, () =>
      captureFollowUpFiles(
        found.paths,
        summary?.file ?? null,
        io,
        transcript?.file ?? null,
        rule.agentRecipients?.length ? 10 * 1024 * 1024 : undefined,
        rule.taskId === null && !rule.agentRecipients?.length
      )
    )
    if (!capture) {
      stop = null
      continue
    }
    await state.save(
      {
        ...withoutStopMarks(rule),
        capturedAt: Date.now(),
        files: capture.pins,
        ...(summary ? { summaryMarkdown: summary.markdown } : {}),
        ...(transcript ? { transcriptFile: transcript.file } : {})
      },
      { state: 'launching' }
    )
    return capture.bytes
  }
}
