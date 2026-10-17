import type { SessionChain } from '../../shared/session-chain-types'
import { outcomeChainCardBound } from '../../shared/outcome-chain-concurrency'
import { runnableSessionOutcomeActions } from '../../shared/session-outcome-state'
import type {
  SessionOutcomeAttempt,
  SessionOutcomeCommit,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from './omni-runtime'
import {
  launchSessionOutcomeAction,
  sessionOutcomeExecutionBrief
} from './session-outcome-executor'
import { blockOutcome, type OutcomeStepAccess } from './session-outcome-step-progress'
import { advanceSessionOutcomeSteps } from './session-outcome-steps'
import { refusedSessionOutcomeAttempt } from './session-outcome-attempt-failure'

export type SessionOutcomeSlots = {
  limit: number
  /** Outcomes a person committed; only these may share the chain with other work. */
  parallel: Set<string>
  inFlight: SessionOutcomeAttempt[]
}

/**
 * Agents this chain may run at once. A card continuation shares one projection and a native
 * continuation chains every dispatch on the previous one, so both stay one at a time.
 *
 * WP-4b: the clamp keys on the ADMITTED continuation and on nothing else. A step routed
 * `same-session` continues the original conversation but admits no card and no native dispatch,
 * so it does not narrow the chain to one agent: a plan may run one continued step beside its
 * ordinary seats. That step is honest about capacity all the same — its attempt is `launching`
 * while it waits for the conversation to go idle and `running` once its turn is delivered, and
 * `inFlightAttempts` counts both, so the continued step holds exactly one seat like any other.
 */
export function sessionOutcomeChainConcurrency(
  runtime: Pick<OrcaRuntimeService, 'getOutcomeChainMaxConcurrentAgents'>,
  chain: SessionChain
): number {
  return outcomeChainCardBound(chain.outcomeSet!.continuation)
    ? 1
    : runtime.getOutcomeChainMaxConcurrentAgents()
}

/**
 * Attempts holding a slot. `unverifiable` holds one on every continuation: a lost launch receipt
 * is not evidence its worker exited, and a launch past the authorized limit cannot be undone.
 */
function inFlightAttempts(set: SessionOutcomeSet): SessionOutcomeAttempt[] {
  return set.attempts.filter((attempt) =>
    ['launching', 'running', 'prepared', 'unverifiable'].includes(attempt.state)
  )
}

/** The chain's free capacity, or null when every slot is taken. */
export function sessionOutcomeSlots(
  runtime: Pick<OrcaRuntimeService, 'getOutcomeChainMaxConcurrentAgents'>,
  chain: SessionChain
): SessionOutcomeSlots | null {
  const limit = sessionOutcomeChainConcurrency(runtime, chain)
  const inFlight = inFlightAttempts(chain.outcomeSet!)
  if (inFlight.length >= limit) {
    return null
  }
  return { limit, parallel: new Set(limit > 1 ? (chain.parallelOutcomeIds ?? []) : []), inFlight }
}

/**
 * Which outcomes may run beside other work after this commit. Only a person's commit consents;
 * an AI commit keeps the consent of outcomes it retained and grants none, so multiple inferred
 * outcomes never become fan-out.
 */
export function sessionOutcomeParallelConsent(
  input: Pick<SessionOutcomeCommit, 'source' | 'outcomes'>,
  old: SessionChain | undefined
): string[] {
  const ids = input.outcomes.map((outcome) => outcome.id)
  if (input.source === 'user') {
    return ids
  }
  return old?.outcomeSet ? (old.parallelOutcomeIds ?? []).filter((id) => ids.includes(id)) : []
}

/**
 * Start what may run now. Work runs alone unless its outcome is user-committed: a solo outcome
 * waits for an idle chain and holds it, though its own review round still fans out. Actions
 * inside one outcome stay sequential, dependents still wait, and nothing passes the limit.
 */
export async function launchSessionOutcomeWork(
  access: OutcomeStepAccess,
  slots: SessionOutcomeSlots
): Promise<void> {
  const { limit, parallel } = slots
  let launched = slots.inFlight.length
  const busy = new Set(slots.inFlight.map((attempt) => attempt.outcomeId))
  const owner = slots.inFlight.find((attempt) => !parallel.has(attempt.outcomeId))?.outcomeId
  const admits = (outcomeId: string): boolean =>
    launched < limit &&
    (owner === undefined || owner === outcomeId) &&
    (parallel.has(outcomeId) || launched === 0 || busy.has(outcomeId))
  const eligible = access
    .read()
    .outcomeSet!.outcomes.filter(
      (outcome, _index, outcomes) =>
        outcome.status !== 'satisfied' &&
        outcome.status !== 'blocked' &&
        outcome.dependsOn.every(
          (id) => outcomes.find((entry) => entry.id === id)?.status === 'satisfied'
        )
    )
  for (const outcome of eligible) {
    if (!admits(outcome.id)) {
      continue
    }
    const result = await advanceSessionOutcomeSteps(access, outcome, limit - launched)
    launched += result.launched
    if (result.launched > 0) {
      busy.add(outcome.id)
    }
    if (result.acted && !parallel.has(outcome.id)) {
      return
    }
  }
  const current = access.read()
  const set = current.outcomeSet!
  const started: Promise<unknown>[] = []
  const refused: SessionOutcomeAttempt[] = []
  for (const next of runnableSessionOutcomeActions(set)) {
    const outcome = set.outcomes.find((entry) => entry.id === next.outcomeId)!
    if (
      busy.has(outcome.id) ||
      !admits(outcome.id) ||
      !(outcome.stepIds ?? []).every((id) => set.completedSteps?.includes(id))
    ) {
      continue
    }
    const action = outcome.actions.find((entry) => entry.id === next.actionId)!
    try {
      // An action whose brief does not fit is refused, never launched on a truncated one. The
      // sequential tick checked this immediately before its single launch; fanning out must not
      // lose the check, so every admitted action is checked before it takes a slot.
      sessionOutcomeExecutionBrief(current, action, 'pending')
    } catch (error) {
      refused.push(
        refusedSessionOutcomeAttempt({
          outcome,
          planVersion: current.planVersion,
          actionId: action.id,
          action,
          error
        })
      )
      continue
    }
    // The slot is taken before the launch is awaited, so a slow workerStart cannot hand the same
    // capacity to a second action, and an authorized sibling need not wait behind it.
    launched += 1
    busy.add(outcome.id)
    started.push(
      launchSessionOutcomeAction(
        access.runtime,
        current,
        outcome.id,
        action,
        access.persistAttempt,
        access.detach
      )
    )
    if (!parallel.has(outcome.id)) {
      break
    }
  }
  // Every launch settles before the tick ends, so the next tick reads their attempts.
  await Promise.all(started)
  // Recorded after the launches settle so each block reads the attempts they persisted. The
  // refusal is an attempt of its own, so the recovery ladder decides what it needs: a shorter
  // brief is asked of the person, anything else is retried within the ladder's bounds.
  for (const attempt of refused) {
    access.persistAttempt(attempt)
    blockOutcome(access, attempt.outcomeId, attempt.error!, {
      class: 'recovering',
      code: attempt.failure?.code ?? 'launch-not-started'
    })
  }
}
