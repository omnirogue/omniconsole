/**
 * Is this conversation free to receive another message from the person?
 *
 * One reading, shared by everything that has to wait for an agent to finish. It is
 * the SAME reading a session chain waits on — `observeSessionOutcomeSource` and this
 * function call one observer — so "the terminal is idle" cannot mean two things in
 * one build. A chain is just the first caller; the prompt queue is the second, and
 * the WorkPlan "same conversation" route will be the third.
 *
 * It answers about the pane only. It never looks at plans, outcomes or cards; a
 * caller that must also refuse while its own work is running checks that itself.
 *
 * TWO readings, one observation: `ready` is "a turn finished, and here is its identity" (what a
 * chain has to follow); `free` is "nothing is in flight" (what the person's own next message has
 * to wait for). They differ exactly where a pane has never finished a turn but is sitting at its
 * prompt, which is every freshly started agent.
 */

import type { AgentTurnFailureKind } from '../../shared/agent-turn-failure'
import type { ConversationSource } from '../../shared/conversation-source'
import { observeSessionOutcomeSourceDescriptor } from './session-outcome-source'
import type { OrcaRuntimeService } from './omni-runtime'

export type ConversationReadiness = {
  /** The last turn finished. False while the agent works, or when nothing can be read. */
  ready: boolean
  /**
   * Nothing is in flight: this conversation is FREE to receive another message from the person.
   *
   * The two readings are not the same question, and answering both with one boolean is what made
   * a brand-new pane read "NOW working claude · 0–2 min" and held a typed `/next` queued for as
   * long as no turn happened to run (round-4 live sim, `evidence/na-live-phase1-20260918T063329Z`
   * cli/10k, 10o, 13d). A fresh agent at its own prompt has no FINISHED turn to build on, so
   * `ready` is honestly false — but nothing is running, so it is free.
   *
   * `ready` implies `free`. A caller that needs the IDENTITY of the turn it is following (a chain
   * settling its own continued delivery) must keep using `ready` + `version`; a caller that only
   * needs the pane to be free (the prompt queue, the Now row) uses this.
   */
  free: boolean
  /** No reading could be made — loss of contact, not evidence of an ending. */
  unverifiable: boolean
  /** Plain words for the person when a definite reading refuses. */
  reason?: string
  /** Identity of the finished turn; distinguishes this ending from a later one. */
  version?: string
  /**
   * While busy: when the work now running started. The host's own state stamp when it has
   * one, else the first moment this host OBSERVED the pane busy — never the time of the
   * reading, so the elapsed the Now row shows only ever grows within one turn.
   */
  busySince?: number
  /** While busy: what the agent is working on, when the host knows it. One line. */
  activity?: string
  /** The last turn ended in this failure (not free); only a login-resume prompt may go to it. */
  failureKind?: AgentTurnFailureKind
}

/**
 * First-observed busy time per pane, for hosts that stamp none of their own (a chat
 * session has no PTY state clock). Cleared the moment the pane reads FREE, so the next
 * turn starts its own elapsed rather than inheriting the last one's.
 */
const observedBusySince = new Map<string, number>()

function busySinceOf(
  paneKey: string,
  busy: boolean,
  stamped: number | undefined,
  now: number
): number | undefined {
  if (!busy) {
    observedBusySince.delete(paneKey)
    return undefined
  }
  if (stamped !== undefined) {
    // The host knows when this state began; that reading wins and replaces any guess.
    observedBusySince.set(paneKey, stamped)
    return stamped
  }
  const known = observedBusySince.get(paneKey)
  if (known !== undefined) {
    return known
  }
  observedBusySince.set(paneKey, now)
  return now
}

export async function observeConversationReadiness(
  runtime: OrcaRuntimeService,
  source: ConversationSource,
  now: number = Date.now()
): Promise<ConversationReadiness> {
  const observed = await observeSessionOutcomeSourceDescriptor(runtime, {
    paneKey: source.paneKey,
    worktreeId: source.worktreeId
  })
  // Free = a finished turn, or positive evidence that no turn is in flight. The elapsed latch
  // below is cleared by the same reading, so a pane that goes free stops reporting a busy clock.
  const free = observed.ready || observed.idle === true
  const busySince = busySinceOf(source.paneKey, !free, observed.since, now)
  return {
    ready: observed.ready,
    free,
    unverifiable: Boolean(observed.unverifiable),
    ...(observed.reason ? { reason: observed.reason } : {}),
    ...(observed.version ? { version: observed.version } : {}),
    ...(busySince !== undefined ? { busySince } : {}),
    ...(observed.activity ? { activity: observed.activity } : {}),
    ...(observed.failureKind ? { failureKind: observed.failureKind } : {})
  }
}
