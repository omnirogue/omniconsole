import { markCodexProjectTrusted } from '../agent-trust-presets'
import type { SessionChain } from '../../shared/session-chain-types'
import {
  decideSessionAttemptRecovery,
  sessionAttemptFailureCode,
  type SessionAttemptRecoveryDecision
} from '../../shared/session-attempt-recovery'
import type { SessionOutcomeAttempt, SessionOutcomeSet } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import { settleProvenSessionOutcomeAttempt } from './session-outcome-attempt-evidence'
import {
  sameRecoveryLineage,
  sessionAttemptWorkerMayStillRun
} from './session-outcome-attempt-failure'
import { stopSessionAttemptWorker } from './session-outcome-attempt-stop'

/**
 * The bounded recovery ladder, applied (`docs/reference/session-run-lifecycle.md`). The policy and
 * its bounds live in `shared/session-attempt-recovery.ts`; this is the host acting on a decision:
 * settle work that is already proven, stop the old worker, start exactly one replacement through
 * the `retryable` primitive. Every other decision is a block, which the status recompute derives
 * from the same policy. It runs inside the chain's lane, so a tick and a person's Resume can never
 * both replace the same attempt.
 */

export const UNCONFIRMED_WORKER_STOP =
  'The previous worker could not be confirmed stopped, so no replacement was started beside it.'

/**
 * Whether this launch's worker is settled dead. Only a receipt proves a process stopped: a retry
 * past an unsettled one is a second agent on the same work, which no one can take back.
 */
export function workerSettledFailed(
  runtime: OrcaRuntimeService,
  attempt: Pick<SessionOutcomeAttempt, 'dispatchId'>
): boolean {
  if (!attempt.dispatchId) {
    return false
  }
  try {
    const db = runtime.getOrchestrationDb()
    const dispatch = db.getDispatchContextById(attempt.dispatchId)
    return (
      db.getWorkerDispatch(attempt.dispatchId)?.state === 'failed' ||
      (dispatch ? db.getTask(dispatch.task_id)?.status === 'failed' : false)
    )
  } catch {
    return false
  }
}

/** The seat runs again; nothing else moves, so a dead seat's siblings keep their results. */
export function retrySessionOutcomeAttempt(
  set: SessionOutcomeSet,
  attemptId: string,
  outcomeId: string
): SessionOutcomeSet {
  return {
    ...set,
    attempts: set.attempts.map((entry) =>
      // The dispatch id stays: a native continuation continues from the dispatch that died. The
      // failure stays too: it is the record of why this replacement was spent.
      entry.id === attemptId ? { ...entry, state: 'retryable', error: undefined } : entry
    ),
    outcomes: set.outcomes.map((entry) =>
      entry.id === outcomeId
        ? { ...entry, status: 'pending', blockedReason: undefined, block: undefined }
        : entry
    )
  }
}

/** A stopped attempt of the plan version and outcome revision that are running now. */
export function isCurrentStoppedAttempt(
  chain: Pick<SessionChain, 'planVersion'>,
  set: SessionOutcomeSet,
  attempt: SessionOutcomeAttempt
): boolean {
  const outcome = set.outcomes.find((entry) => entry.id === attempt.outcomeId)
  return Boolean(
    outcome &&
    (attempt.state === 'blocked' || attempt.state === 'unverifiable') &&
    (attempt.planVersion ?? 1) >= (chain.planVersion ?? 1) &&
    attempt.outcomeRevision === outcome.revision
  )
}

/** What the ladder says about one stopped attempt, with the proofs only the host can read. */
export function sessionAttemptRecoveryDecision(
  runtime: OrcaRuntimeService,
  set: SessionOutcomeSet,
  attempt: SessionOutcomeAttempt,
  now: number,
  userInitiated = false
): SessionAttemptRecoveryDecision {
  const retriesUsed = set.attempts.filter(
    (entry) => entry.state === 'retryable' && sameRecoveryLineage(entry, attempt)
  ).length
  // A person's Resume after a sign-in failure or an oversized brief is their answer; the policy
  // itself tries it, through the same safety proof as any relaunch.
  return decideSessionAttemptRecovery({
    attempt,
    retriesUsed,
    // A record that itself says the worker could not be verified (an unconfirmed stop, a turn
    // delivered into a conversation) is not overruled by a settled row: the row is the host's
    // verdict, never proof that the process is gone.
    workerSettled:
      attempt.launchDisposition !== 'unverifiable' && workerSettledFailed(runtime, attempt),
    now,
    userInitiated
  })
}

/** Remediation the host may do by itself before a relaunch; the launch re-runs its own preflight. */
async function remediateStartupBlock(
  chain: SessionChain,
  attempt: SessionOutcomeAttempt
): Promise<void> {
  if (attempt.failure?.detail !== 'codex-trust-workspace') {
    return
  }
  try {
    // The launch preflight swallows a failed trust write; here it is at least said.
    await markCodexProjectTrusted(chain.workspacePath)
  } catch (error) {
    console.warn('[outcomes] could not pre-trust the workspace for Codex', chain.id, error)
  }
}

/** The pass's one clock: the service's injectable one, or the wall clock for a host without it. */
export function sessionOutcomePassClock(service: { now?: () => number }, at?: number): number {
  return at ?? service.now?.() ?? Date.now()
}

export type SessionAttemptRecoveryInput = {
  runtime: OrcaRuntimeService
  chain: SessionChain
  set: SessionOutcomeSet
  now: number
  /** The person pressed Resume: the bound and the deadline lift, the safety proofs never do. */
  userInitiated?: boolean
  /** A launch this host is still waiting on is alive, whatever its attempt says right now. */
  inFlight?: (attemptId: string) => boolean
}

export async function recoverSessionOutcomeAttempts(
  input: SessionAttemptRecoveryInput
): Promise<SessionOutcomeSet> {
  const { runtime, chain, now, userInitiated = false } = input
  let set = input.set
  // A sealed or cancelled run is finished business: nothing of it is ever started again.
  if (set.completion || chain.state === 'cancelled') {
    return set
  }
  for (const { id } of input.set.attempts) {
    const attempt = set.attempts.find((entry) => entry.id === id)
    const outcome = set.outcomes.find((entry) => entry.id === attempt?.outcomeId)
    if (
      !attempt ||
      !outcome ||
      outcome.status === 'satisfied' ||
      input.inFlight?.(attempt.id) ||
      // Resume reaches every stopped attempt, as it always has; the host only the current ones.
      !(userInitiated
        ? attempt.state === 'blocked' || attempt.state === 'unverifiable'
        : isCurrentStoppedAttempt(chain, set, attempt))
    ) {
      continue
    }
    const decision = sessionAttemptRecoveryDecision(runtime, set, attempt, now, userInitiated)
    // Rung 1 — evidence. Read when the attempt is first seen stopped and again before anything is
    // relaunched, so a timeout a moment before completion never costs the completed work.
    const firstSeen = (attempt.failure?.at ?? attempt.updatedAt) === now
    if (userInitiated || firstSeen || decision.kind === 'retry') {
      const proven = await settleProvenSessionOutcomeAttempt(runtime, chain, set, attempt, now)
      set = proven.set
      if (proven.settled) {
        continue
      }
    }
    if (decision.kind !== 'retry') {
      continue
    }
    if (attempt.dispatchId && sessionAttemptWorkerMayStillRun(sessionAttemptFailureCode(attempt))) {
      const stop = await stopSessionAttemptWorker(runtime, attempt)
      if (stop === 'pending') {
        // The owned lifecycle holds a durable intent (mail, protection, descendants). Nothing is
        // recorded: the next pass asks again and relaunches once the release settles.
        continue
      }
      if (stop === 'unknown') {
        // Recorded on the attempt, so every later pass holds it as unverifiable and none relaunches.
        set = {
          ...set,
          attempts: set.attempts.map((entry) =>
            entry.id === attempt.id
              ? { ...entry, launchDisposition: 'unverifiable', error: UNCONFIRMED_WORKER_STOP }
              : entry
          )
        }
        continue
      }
    }
    await remediateStartupBlock(chain, attempt)
    set = retrySessionOutcomeAttempt(set, attempt.id, outcome.id)
  }
  return set
}
