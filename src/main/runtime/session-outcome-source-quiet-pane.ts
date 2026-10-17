/**
 * The source reading for a live terminal pane whose agent reports NO hook row.
 *
 * A hook `done` row is how the host normally learns that a turn ended. An agent without hook
 * coverage (or one whose row never reached this host) never writes one, and "PTY alive, no row" used
 * to read `{ready:false, idle:true}` for as long as the pane stayed open: the run waited for a turn
 * ending nobody would ever report (`reports/handoff-diagnosis.md`, chain `source_08ea603c…`).
 *
 * The host already has evidence of its own, and it is read here in order of strength:
 *   1. a pending interactive prompt, or an agent status of `working`/`permission` — the runtime's
 *      own reading of the pane's prompt text and title — is a turn in flight: never ready;
 *   2. an agent status of `idle` with no prompt pending is the agent at its own prompt. Ready once
 *      the pane has also stopped moving for `SOURCE_IDLE_SETTLE_MS`, which keeps a commit from
 *      racing a message the person sent a moment earlier;
 *   3. no status at all (an agent the runtime cannot read a title from): ready only after the pane
 *      has been provably quiet — not one new byte — for `SOURCE_QUIET_PANE_MS`. A working agent
 *      paints a spinner, so a pane that still moves never qualifies.
 * 2 and 3 both need the prompt check and the status reading to have RUN, and the prompt check to
 * have found nothing: a parked question is quiet too. Where only a SUCCESSFUL turn counts, a quiet
 * shell whose agent is gone is not one, as an exited terminal is not.
 *
 * Until one of those holds the reading is classified (`wait`), so the run says what it is waiting
 * for instead of waiting silently.
 */
import { createHash } from 'node:crypto'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { RuntimeTerminalRead } from '../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from './omni-runtime'
import type { SessionOutcomeSourceDescriptor, SourceObservation } from './session-outcome-source'

/** The classified wait a not-yet-finished live source is: the tick turns it into a `waiting` block. */
export const SOURCE_TURN_WAIT = {
  code: 'source-turn',
  wake: 'this conversation to finish its turn'
} as const

export const SOURCE_IDLE_SETTLE_MS = 3_000
export const SOURCE_QUIET_PANE_MS = 60_000

const ASKING_SOURCE = 'The source agent needs your input.'
const MAX_TRACKED_PANES = 256

type QuietPane = { incarnation: string; mark: string; since: number }

const quietPanes = new WeakMap<OrcaRuntimeService, Map<string, QuietPane>>()

function trackedPanes(runtime: OrcaRuntimeService): Map<string, QuietPane> {
  let panes = quietPanes.get(runtime)
  if (!panes) {
    panes = new Map()
    quietPanes.set(runtime, panes)
  }
  return panes
}

/** A probe of a remote pane can wedge; the tick serializes every chain, so it must not wait on it. */
const PANE_READING_TIMEOUT_MS = 2_000

/** `undefined` when the host cannot make the reading at all, which is never the same as "none". */
async function evaluated<T>(read: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await withTimeout<T | undefined>(
      Promise.resolve(read()),
      PANE_READING_TIMEOUT_MS,
      undefined
    )
  } catch {
    return undefined
  }
}

/** Everything the pane has printed so far, as one comparable mark: it moves with any new output. */
function outputMark(read: RuntimeTerminalRead): string {
  return createHash('sha256')
    .update(JSON.stringify([read.latestCursor ?? null, read.tail]))
    .digest('hex')
}

export async function observeSourcePaneWithoutHook(input: {
  runtime: OrcaRuntimeService
  source: SessionOutcomeSourceDescriptor
  handle: string
  read: RuntimeTerminalRead
  now: number
  successfulOnly?: boolean
}): Promise<SourceObservation> {
  const { runtime, source, handle, read, now } = input
  const panes = trackedPanes(runtime)
  const key = JSON.stringify([source.worktreeId, source.paneKey])
  const wait = await evaluated(() => runtime.getTerminalInteractiveWait(handle))
  const agent = await evaluated(() => runtime.getTerminalAgentStatus(handle))
  if (wait || agent?.status === 'permission') {
    panes.delete(key)
    return { ready: false, reason: ASKING_SOURCE, wait: SOURCE_TURN_WAIT }
  }
  if (agent?.status === 'working') {
    panes.delete(key)
    return { ready: false, wait: SOURCE_TURN_WAIT }
  }
  // Nothing shows a turn in flight, so the conversation is free either way (`idle`); whether a
  // turn FINISHED is what the quiet period below establishes.
  const settling: SourceObservation = {
    ready: false,
    idle: true,
    settling: true,
    wait: SOURCE_TURN_WAIT
  }
  const paneKey = await evaluated(() => runtime.getTerminalPaneKey(handle))
  const incarnation = await evaluated(() => runtime.getTerminalProcessIncarnation(handle))
  if (!paneKey || !incarnation) {
    return settling
  }
  const mark = outputMark(read)
  let quiet = panes.get(key)
  if (!quiet || quiet.incarnation !== incarnation || quiet.mark !== mark) {
    quiet = { incarnation, mark, since: now }
    panes.delete(key)
    panes.set(key, quiet)
    if (panes.size > MAX_TRACKED_PANES) {
      panes.delete(panes.keys().next().value!)
    }
  }
  // `null` is "evaluated, no prompt pending". An agent parked on a question is quiet too, and one
  // mid-way through a silent tool call is quiet for a while: a wait or an agent status that could
  // not be read can never be what reads a turn as finished.
  if (wait !== null || !agent || (input.successfulOnly && !agent.isRunningAgent)) {
    return settling
  }
  const atOwnPrompt = agent.status === 'idle' && agent.isRunningAgent
  if (now - quiet.since < (atOwnPrompt ? SOURCE_IDLE_SETTLE_MS : SOURCE_QUIET_PANE_MS)) {
    return settling
  }
  return {
    ready: true,
    version: createHash('sha256')
      .update(
        JSON.stringify(['pty-source-quiet-v1', source.paneKey, paneKey, incarnation, quiet.mark])
      )
      .digest('hex')
  }
}
