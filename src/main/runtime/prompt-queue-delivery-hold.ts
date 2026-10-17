/**
 * The prompt queue's hold after a delivery (`prompt-queue-drain.ts`): the next entry waits until
 * the agent visibly took the last one up. Every sender to a queued conversation sets it.
 */

import type { OrcaRuntimeService } from './omni-runtime'

/**
 * After a delivery the pane can still read free for a moment, before the agent reports it is
 * working on it. The next entry waits until the agent was seen busy or finished a different turn.
 */
type DeliveryHold = { version?: string; busySeen: boolean; at: number }
const holds = new WeakMap<OrcaRuntimeService, Map<string, DeliveryHold>>()
/** A pane that shows no sign of the delivery for this long is not working on it. */
export const PROMPT_QUEUE_DELIVERY_SETTLE_MS = 3 * 60_000

function holdsFor(runtime: OrcaRuntimeService): Map<string, DeliveryHold> {
  let map = holds.get(runtime)
  if (!map) {
    map = new Map()
    holds.set(runtime, map)
  }
  return map
}

/**
 * Holds the queue behind a delivery until the agent visibly takes it up. `version` is the turn
 * identity read BEFORE the write; every sender to a queued conversation calls this, not just the drain.
 */
export function holdPromptQueueAfterDelivery(
  runtime: OrcaRuntimeService,
  rowKey: string,
  version: string | undefined
): void {
  holdsFor(runtime).set(rowKey, {
    ...(version ? { version } : {}),
    busySeen: false,
    at: Date.now()
  })
}

type HoldReadiness = { free: boolean; unverifiable: boolean; version?: string }

/** A free pane took the delivery up once seen busy, after another turn, or past the settle time. */
function isHoldReleased(hold: DeliveryHold, readiness: HoldReadiness, now: number): boolean {
  return (
    hold.busySeen ||
    (readiness.version !== undefined && readiness.version !== hold.version) ||
    now - hold.at >= PROMPT_QUEUE_DELIVERY_SETTLE_MS
  )
}

/** True while the previous delivery has not visibly been taken up by the agent. */
export function heldByPreviousDelivery(
  runtime: OrcaRuntimeService,
  rowKey: string,
  readiness: HoldReadiness,
  now: number
): boolean {
  const map = holdsFor(runtime)
  const hold = map.get(rowKey)
  if (!hold) {
    return false
  }
  if (!readiness.free) {
    // Loss of contact is not evidence the agent took the prompt up.
    if (!readiness.unverifiable) {
      hold.busySeen = true
    }
    return true
  }
  if (isHoldReleased(hold, readiness, now)) {
    map.delete(rowKey)
    return false
  }
  return true
}

/**
 * The same reading for a caller outside the drain (archive sleep), which never marks or releases
 * the hold: true while a delivered prompt may not have reached the agent's turn yet.
 */
export function isPromptQueueDeliveryHeld(
  runtime: OrcaRuntimeService,
  rowKey: string,
  readiness: HoldReadiness,
  now: number = Date.now()
): boolean {
  const hold = holds.get(runtime)?.get(rowKey)
  return hold ? !readiness.free || !isHoldReleased(hold, readiness, now) : false
}
