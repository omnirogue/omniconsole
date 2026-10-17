import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeAttempt } from '../../shared/session-outcome-types'

/**
 * Hands the readiness wait of a launch to the host: `work` runs after the tick that started it
 * returns, and persists through the chain's own lane rather than the tick's stale snapshot. The
 * attempt is already durable when this is called, so a host that dies mid-wait reconciles the
 * attempt by observation instead of launching a second agent.
 */
export type SessionOutcomeLaunchDetach = (
  attemptId: string,
  work: (persist: (attempt: SessionOutcomeAttempt) => Promise<void>) => Promise<void>
) => void

/**
 * The launches this host is still waiting on. An attempt listed here is alive in this process, so
 * the tick must not read its silence as a failed launch — that is the only thing memory decides;
 * after a restart nothing is listed and every attempt is judged from its persisted receipts.
 */
export class SessionOutcomeLaunches {
  private readonly running = new Map<string, Promise<unknown>>()

  inFlight(attemptId: string): boolean {
    return this.running.has(attemptId)
  }

  count(): number {
    return this.running.size
  }

  /**
   * @param persist must REJECT when the write failed: a launch awaits each checkpoint before its
   * next external step, so a host that cannot record what it is about to do never does it.
   */
  detachWith(
    persist: (attempt: SessionOutcomeAttempt) => Promise<void>
  ): SessionOutcomeLaunchDetach {
    return (attemptId, work) => {
      const settled = work(persist)
        .catch((error) => console.warn('[outcomes] detached launch failed', attemptId, error))
        .finally(() => {
          if (this.running.get(attemptId) === settled) {
            this.running.delete(attemptId)
          }
        })
      this.running.set(attemptId, settled)
    }
  }

  /** Resolves once every launch this host started has stopped waiting. Never rejects. */
  async settled(): Promise<void> {
    await Promise.allSettled(this.running.values())
  }
}

/** Attempt states nothing reported later may move: the attempt is over, or was retired on purpose. */
const SETTLED_ATTEMPT_STATES: ReadonlySet<SessionOutcomeAttempt['state']> = new Set([
  'completed',
  'superseded',
  'retryable'
])

/**
 * Whether an attempt event still describes the run as it is now. A launch can report minutes after
 * it started, by which time the run may be sealed, its plan superseded, its outcome revised or the
 * attempt itself settled; an event about any of those is about something that no longer exists.
 */
export function isCurrentSessionOutcomeAttempt(
  chain: SessionChain,
  attempt: SessionOutcomeAttempt
): boolean {
  const set = chain.outcomeSet
  if (!set || set.completion || chain.state === 'cancelled') {
    return false
  }
  const outcome = set.outcomes.find((entry) => entry.id === attempt.outcomeId)
  if (!outcome || outcome.revision !== attempt.outcomeRevision) {
    return false
  }
  if ((attempt.planVersion ?? 1) < (chain.planVersion ?? 1)) {
    return false
  }
  const recorded = set.attempts.find((entry) => entry.id === attempt.id)
  return (
    !recorded || !SETTLED_ATTEMPT_STATES.has(recorded.state) || recorded.state === attempt.state
  )
}

/** Said to a launch whose run moved on without it, so it stops before its next external step. */
export const SESSION_OUTCOME_ATTEMPT_STALE =
  'This attempt no longer belongs to the run as it is now; its event was dropped.'

/**
 * Writes one attempt of a detached launch back. The chain is re-read here rather than taken from
 * the tick that started the launch: that snapshot is minutes old by now, and saving it would undo
 * everything the chain did meanwhile. A late event for a sealed run, a superseded attempt or a
 * generation that no longer matches is never written; it REJECTS instead, because a launch awaits
 * each checkpoint before its next external step and must not start an agent for work that is
 * finished or retired. Call it inside the chain's own lane.
 */
export function mergeSessionOutcomeAttempt(
  lane: {
    get(chainId: string): SessionChain
    save(chain: SessionChain, expectedRevision: number): SessionChain
  },
  chainId: string,
  attempt: SessionOutcomeAttempt
): void {
  const chain = lane.get(chainId)
  if (!isCurrentSessionOutcomeAttempt(chain, attempt)) {
    throw new Error(SESSION_OUTCOME_ATTEMPT_STALE)
  }
  const set = chain.outcomeSet!
  lane.save(
    {
      ...chain,
      outcomeSet: {
        ...set,
        attempts: set.attempts.some((entry) => entry.id === attempt.id)
          ? set.attempts.map((entry) => (entry.id === attempt.id ? attempt : entry))
          : [...set.attempts, attempt]
      }
    },
    set.revision
  )
}
