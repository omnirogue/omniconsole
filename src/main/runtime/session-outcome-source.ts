import { createHash } from 'node:crypto'
import {
  describeAgentTurnFailure,
  type AgentTurnFailureKind
} from '../../shared/agent-turn-failure'
import { loginKilledWhileWorking, turnFailureKind } from '../answer-delivery/login-killed-turns'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { parseAskFromStatus } from '../../shared/native-chat-ask'
import { sessionQuestionSummary } from '../../shared/session-questions'
import type { OrcaRuntimeService } from './omni-runtime'
import { observeSourcePaneWithoutHook, SOURCE_TURN_WAIT } from './session-outcome-source-quiet-pane'

/** A pending prompt in words: a question's own text, never the JSON it arrives as. */
function pendingPromptReason(interactivePrompt: string): string {
  const ask = parseAskFromStatus(interactivePrompt)
  return ask && ask.questions.length > 0
    ? `The agent is waiting for your answer: ${sessionQuestionSummary(ask)}`
    : interactivePrompt
}

export type SourceObservation = {
  ready: boolean
  /**
   * Positive evidence that NO TURN IS IN FLIGHT, which is a different question from `ready`.
   *
   * `ready` answers the chain's question — "did a turn finish, and which one?" — and needs a
   * completed turn with an identity to build on. This answers the conversation's: "is anything
   * running right now?". A pane can be free without a finished turn: an agent that has just
   * started and landed at its own prompt, a session boundary (connect/resume/clear), a chat
   * with no turn yet. `ready` implies this; the reverse does not.
   *
   * Absent means the reading proves neither, so a caller that must not interrupt waits
   * (`conversation-readiness.ts`). It is deliberately NOT set while the agent works, while it
   * is asking the person something, or when no reading could be made at all: a running PROCESS
   * is evidence the pane is alive, never evidence that a turn is in flight.
   */
  idle?: boolean
  version?: string
  reason?: string
  unverifiable?: boolean
  /**
   * When the state this reading saw was ENTERED, when the host stamps it. Pinned across
   * same-state pings, so it is the start of the turn that is running now and not the time
   * of the reading — the only honest basis for "working for 6 min" (v3 amendment 1).
   */
  since?: number
  /** What the agent is working on, when the host knows it: its current prompt, one line. */
  activity?: string
  /**
   * What a live source that has not finished is waiting FOR, classified so the run can say it
   * (a `waiting` block with this code and wake) instead of waiting with no reason at all.
   */
  wait?: { code: 'source-turn'; wake: string }
  /**
   * Nothing shows a turn in flight, but nothing proves one finished yet either: the pane has to
   * stay quiet a little longer. Inconclusive, like lost contact — it contradicts no earlier proof.
   */
  settling?: boolean
  /** The last turn ended in this failure; a login failure reads `authentication`. */
  failureKind?: AgentTurnFailureKind
}

export type SessionOutcomeSourceObserveOptions = {
  successfulOnly?: boolean
  /** The pass's clock; quiet periods are measured on it, so a test can inject it. */
  now?: number
}

/** The host's injectable clock, so a quiet period is measured on the tick's own clock. */
function sourceObservationClock(runtime: OrcaRuntimeService): number {
  try {
    return runtime.getSessionOutcomeService().now()
  } catch {
    return Date.now()
  }
}

/** One line, bounded: a Now row says what the turn is about, never the whole prompt. */
function activityLine(prompt: string | undefined): string | undefined {
  const line = (prompt ?? '').split('\n', 1)[0]!.trim()
  if (!line) {
    return undefined
  }
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/**
 * The facts a busy PTY reading carries beyond "not ready": when this state began and what
 * the turn is about. Both are the host's own words — absent rather than guessed.
 */
function busyFacts(hook: { prompt?: string; stateStartedAt?: number }): {
  since?: number
  activity?: string
} {
  const since =
    typeof hook.stateStartedAt === 'number' &&
    Number.isFinite(hook.stateStartedAt) &&
    hook.stateStartedAt > 0
      ? hook.stateStartedAt
      : undefined
  const activity = activityLine(hook.prompt)
  return { ...(since !== undefined ? { since } : {}), ...(activity ? { activity } : {}) }
}

/**
 * WHICH conversation is being observed, with nothing about why.
 *
 * Readiness is a property of a pane, not of a plan: the same three readings answer
 * "did its turn finish?" for a chain's source, for a queued prompt and for anything
 * later that needs a conversation to be free. A chain is one caller that fills this
 * in from its own fields; `nativeSource` is the only reading a chain alone can hold.
 */
export type SessionOutcomeSourceDescriptor = {
  paneKey: string
  worktreeId: string
  nativeSource?: NonNullable<SessionChain['outcomeSet']>['continuation']['nativeSource']
}

export function sessionOutcomeSourceDescriptor(
  chain: SessionChain
): SessionOutcomeSourceDescriptor {
  return {
    paneKey: chain.sourcePaneKey,
    worktreeId: chain.sourceWorktreeId ?? chain.worktreeId,
    ...(chain.outcomeSet?.continuation.nativeSource
      ? { nativeSource: chain.outcomeSet.continuation.nativeSource }
      : {})
  }
}

const INTERRUPTED_SOURCE =
  'The source session was interrupted before it finished. Run it again before continuing.'
const FAILED_SOURCE = 'The source session failed before it finished.'
const UNSETTLED_SOURCE =
  'The source session never recorded how its turn ended, so it cannot count as finished.'

/** Chat sessions have no PTY; their host journal says whether the source turn finished. */
function observeStructuredSource(source: SessionOutcomeSourceDescriptor): SourceObservation | null {
  const host = getStructuredAgentSessionHost()
  const workspaceId = source.worktreeId
  const matches = (host?.listSessionTabs() ?? []).filter(
    (session) =>
      session.workspaceId === workspaceId &&
      structuredAgentSessionPaneKey(
        structuredAgentSessionTabId(session.sessionId),
        session.sessionId
      ) === source.paneKey
  )
  const turn = matches.length === 1 ? host!.turnState(matches[0]!.sessionId) : null
  if (!turn) {
    return null
  }
  if (turn.running || turn.awaitingStart) {
    return { ready: false }
  }
  // A chat that has taken no turn at all has none to build on — and none in flight either, so
  // the person's own next message has nothing to wait for.
  if (!turn.hasTurn) {
    return { ready: false, idle: true }
  }
  if (turn.outcome === 'interrupted') {
    return { ready: false, reason: INTERRUPTED_SOURCE }
  }
  if (turn.outcome === 'failed') {
    return { ready: false, reason: FAILED_SOURCE }
  }
  // Assistant text with no settled lifecycle row is not completion evidence.
  if (turn.outcome !== 'completed') {
    return { ready: false, unverifiable: true, reason: UNSETTLED_SOURCE }
  }
  return {
    ready: true,
    version: createHash('sha256')
      .update(`structured:${matches[0]!.sessionId}:${turn.lastSequence}`)
      .digest('hex')
  }
}

/**
 * Ready only when every reading that exists agrees. A refusal always wins, and a definite
 * refusal is reported ahead of an unverifiable one so a real failure is named rather than
 * reported as loss of contact. Null when no structured reading is available at all.
 */
function agreedSourceObservation(
  ...observations: readonly (SourceObservation | null | undefined)[]
): SourceObservation | null {
  const present = observations.filter((entry): entry is SourceObservation => Boolean(entry))
  if (!present.length) {
    return null
  }
  const refusals = present.filter((entry) => !entry.ready)
  if (!refusals.length) {
    return present[0]!
  }
  return refusals.find((entry) => !entry.unverifiable) ?? refusals[0]!
}

export async function observeSessionOutcomeSource(
  runtime: OrcaRuntimeService,
  chain: SessionChain,
  options?: SessionOutcomeSourceObserveOptions
): Promise<SourceObservation> {
  return observeSessionOutcomeSourceDescriptor(
    runtime,
    sessionOutcomeSourceDescriptor(chain),
    options
  )
}

/** The same reading, addressed by conversation rather than by chain. */
export async function observeSessionOutcomeSourceDescriptor(
  runtime: OrcaRuntimeService,
  source: SessionOutcomeSourceDescriptor,
  options?: SessionOutcomeSourceObserveOptions
): Promise<SourceObservation> {
  try {
    const native = source.nativeSource
    if (native) {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(native.sourceDispatchId)
      const worker = db.getWorkerDispatch(native.sourceDispatchId)
      if (
        dispatch?.task_id !== native.projectionTaskId ||
        dispatch.run_id !== native.runId ||
        !worker
      ) {
        throw new Error('The original native source receipt is unavailable.')
      }
      if (dispatch.status === 'completed' && worker.state === 'succeeded') {
        return { ready: true, version: createHash('sha256').update(dispatch.id).digest('hex') }
      }
      return {
        ready: false,
        ...(['failed', 'stopped', 'abandoned'].includes(worker.state)
          ? { reason: 'The original native source did not finish successfully.' }
          : {})
      }
    }
    // Two independent readings of the same chat source, deliberately kept side by side.
    // #289's host turn state tells an interrupted turn from a failed one and refuses a turn
    // that never recorded how it ended; #283's journal observation binds the ending to the
    // exact admission receipt and refuses while an approval or question is still pending.
    // Neither refusal can be evaluated from the other's evidence, so the combined reading is
    // ready only when every available reading says ready.
    const structured = agreedSourceObservation(
      observeStructuredSource(source),
      getStructuredAgentSessionHost()?.outcomeSource?.observe(source.paneKey, source.worktreeId)
    )
    if (structured) {
      return structured
    }
    const pane = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
    const hook = runtime.getFreshAgentHookStatusForHandle(pane.handle)
    if (hook?.state === 'done') {
      // `done` after an interrupt ends the turn without finishing the work.
      if (hook.interrupted) {
        return { ready: false, reason: INTERRUPTED_SOURCE }
      }
      // A turn that ended in failure did not finish the work either; #292 names the failure
      // (rate limit, expired auth, ...) instead of starting a successor on it.
      if (hook.failed) {
        return {
          ready: false,
          reason: describeAgentTurnFailure(hook.failureReason),
          failureKind: turnFailureKind(hook.failureReason)
        }
      }
      // A session boundary or a pending prompt is equally not a finished turn.
      if (hook.sessionBoundary || hook.interactivePrompt) {
        return {
          ready: false,
          // A boundary (connect/resume/clear, and the SessionStart every fresh Claude Code pane
          // reports) is the agent sitting at its own prompt: nothing is in flight, so the
          // conversation is FREE even though no turn finished here. A pending question is not:
          // an answer to the agent's own prompt is not the person's next message.
          ...(hook.sessionBoundary && !hook.interactivePrompt ? { idle: true } : {}),
          reason: hook.interactivePrompt
            ? pendingPromptReason(hook.interactivePrompt)
            : 'The source has no successful completed turn.'
        }
      }
      const paneKey = runtime.getTerminalPaneKey(pane.handle)
      const processIncarnation = runtime.getTerminalProcessIncarnation(pane.handle)
      if (
        !paneKey ||
        !processIncarnation ||
        !Number.isFinite(hook.stateStartedAt) ||
        hook.stateStartedAt < 0
      ) {
        throw new Error('The source completed-turn identity is unavailable.')
      }
      return {
        ready: true,
        version: createHash('sha256')
          .update(
            JSON.stringify([
              'pty-source-turn-v1',
              source.paneKey,
              paneKey,
              processIncarnation,
              hook.stateStartedAt,
              hook.lastAssistantMessage ?? null
            ])
          )
          .digest('hex')
      }
    }
    if (hook?.state === 'working') {
      const loginKilled = loginKilledWhileWorking(source.paneKey, hook.stateStartedAt)
      if (loginKilled) {
        return {
          ready: false,
          reason: describeAgentTurnFailure(loginKilled),
          failureKind: 'authentication'
        }
      }
      return { ready: false, wait: SOURCE_TURN_WAIT, ...busyFacts(hook) }
    }
    if (hook?.state === 'blocked' || hook?.state === 'waiting') {
      return {
        ready: false,
        reason:
          hook.interactivePrompt ??
          hook.lastAssistantMessage ??
          'The source agent needs your input.',
        wait: SOURCE_TURN_WAIT,
        ...busyFacts(hook)
      }
    }
    const read = await runtime.readTerminal(pane.handle, { limit: 100 })
    if (read.status === 'exited' && !options?.successfulOnly) {
      return {
        ready: true,
        version: createHash('sha256').update(read.tail.join('\n')).digest('hex')
      }
    }
    if (read.status === 'running') {
      // The PROCESS is alive, which for a CONVERSATION is true for as long as the pane exists: it
      // never means "a turn is in flight", and with no hook row it never said "a turn finished"
      // either — which left the run waiting for ever. The host's own reading of the pane decides.
      return await observeSourcePaneWithoutHook({
        runtime,
        source,
        handle: pane.handle,
        read,
        now: options?.now ?? sourceObservationClock(runtime),
        successfulOnly: options?.successfulOnly
      })
    }
  } catch {
    /* Loss of the pane/host is not evidence of an exit. */
  }
  return {
    ready: false,
    unverifiable: true,
    reason:
      'Source execution is unverifiable. Restore its host or source session before continuing.'
  }
}
