/**
 * Per-delivery backoff on this computer for work it does not hold. A delivery held because no
 * session here is bound to it (`not_found`), or because its session cannot be verified and is never
 * woken a second time, is claimed here again after 15 min, then 30 and 60, at most every 4 h, and
 * its hold is logged once per step. OmniOS keeps offering it, so nothing is dropped and another
 * computer may take it meanwhile. Work OmniOS binds to a conversation on this computer keeps its
 * old cadence, including an offer that becomes bound here mid-backoff. Kept in memory: a restart
 * (or more than 1,000 tracked deliveries) starts a delivery again at the first step.
 */

import type { ClaimableDelivery } from './work-delivery-kind'

export const ELSEWHERE_FIRST_WAIT_MS = 15 * 60_000
export const ELSEWHERE_MAX_WAIT_MS = 4 * 60 * 60_000
const MAX_STEP = Math.ceil(Math.log2(ELSEWHERE_MAX_WAIT_MS / ELSEWHERE_FIRST_WAIT_MS)) + 1
const MAX_TRACKED = 1_000

type Step = { step: number; until: number }

export type ElsewhereBackoffDeps = {
  now(): number
  audit(delivery: ClaimableDelivery, summary: string): void
}

/** OmniOS binds it to a conversation on this computer: this computer owns it. */
export function boundHere(delivery: ClaimableDelivery, hostId: string): boolean {
  return delivery.owner?.hostId === hostId && !!delivery.owner.conversationId
}

export function elsewhereWaitMs(step: number): number {
  return Math.min(ELSEWHERE_FIRST_WAIT_MS * 2 ** (step - 1), ELSEWHERE_MAX_WAIT_MS)
}

function waitText(ms: number, capped: boolean): string {
  const minutes = Math.round(ms / 60_000)
  const span = minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
  return capped ? `It is tried here again every ${span}.` : `It is tried here again in ${span}.`
}

export class WorkDeliveryElsewhereBackoff {
  private readonly steps = new Map<string, Step>()

  constructor(private readonly deps: ElsewhereBackoffDeps) {}

  /**
   * The offers to claim now: one still waiting out its step here is left for later, unless the
   * offer now binds it to a conversation on this computer.
   */
  due<T extends ClaimableDelivery>(offered: readonly T[], hostId: string): T[] {
    const now = this.deps.now()
    return offered.filter(
      (delivery) => boundHere(delivery, hostId) || (this.steps.get(delivery.key)?.until ?? 0) <= now
    )
  }

  /**
   * Logs a hold. Any other hold, or one of work bound here, resets the backoff and logs as before;
   * an elsewhere hold steps it and logs only when the step changes.
   */
  logHold(delivery: ClaimableDelivery, hostId: string, elsewhere: boolean, line: string): void {
    if (!elsewhere || boundHere(delivery, hostId)) {
      this.steps.delete(delivery.key)
      this.deps.audit(delivery, line)
      return
    }
    const previous = this.steps.get(delivery.key)?.step ?? 0
    const step = Math.min(previous + 1, MAX_STEP)
    const waitMs = elsewhereWaitMs(step)
    // Why delete first: re-inserting keeps the map oldest-first for the size cap.
    this.steps.delete(delivery.key)
    this.steps.set(delivery.key, { step, until: this.deps.now() + waitMs })
    if (this.steps.size > MAX_TRACKED) {
      this.steps.delete(this.steps.keys().next().value!)
    }
    if (step !== previous) {
      this.deps.audit(delivery, `${line} ${waitText(waitMs, step === MAX_STEP)}`)
    }
  }
}
