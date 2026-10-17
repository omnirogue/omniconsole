/**
 * Which path delivers an answer on this computer. An answered decision or Question that carries a
 * `deliveryKey` belongs to the work-delivery claimer while it is polling for that kind; the older
 * paths (the review pass, the Questions answer round) keep everything else, and take one over only
 * when the claimer is not polling and nothing was started for it. What either path types into a
 * Question card is marked here, so the other never types it a second time.
 */

import type { WorkDeliveryKind } from '../work-delivery/work-delivery-kind'

/** The claimer polls every 15 s; four missed polls and the older paths take new answers back. */
export const CLAIMER_FRESH_MS = 60_000

let claimer: { kinds: ReadonlySet<WorkDeliveryKind>; polledAt: number } | null = null

/**
 * The claimer listed what it may claim (OmniOS answered) for these kinds. Also noted when it is
 * installed, so the older paths do not take answers in the first seconds after a start.
 */
export function noteClaimerPolled(kinds: readonly WorkDeliveryKind[], now = Date.now()): void {
  claimer = { kinds: new Set(kinds), polledAt: now }
}

export function clearClaimerPolled(): void {
  claimer = null
}

export function claimerTakes(kind: WorkDeliveryKind, now = Date.now()): boolean {
  return !!claimer && claimer.kinds.has(kind) && now - claimer.polledAt < CLAIMER_FRESH_MS
}

/** The part of a delivery an older path reads (`delivery` on a review status). */
export type HandoverDelivery = { state?: string | null; step?: string | null } | null | undefined

/**
 * Whether the older path leaves this answer to the claimer: always while the claimer polls, and
 * otherwise once anything was started for it (typed, reopened, or held after such a step).
 */
export function leftToClaimer(
  kind: WorkDeliveryKind,
  deliveryKey: string | null | undefined,
  delivery?: HandoverDelivery,
  now = Date.now()
): boolean {
  if (!deliveryKey) {
    return false
  }
  if (claimerTakes(kind, now)) {
    return true
  }
  if (!delivery) {
    return false
  }
  const untouched =
    (delivery.state === 'pending' || delivery.state === 'held') &&
    (!delivery.step || delivery.step === 'claimed')
  return !untouched
}

// Keyed by delivery key (one per answer round), so a person answering the card again starts clean.
const typing = new Set<string>()
const typed = new Set<string>()
const uncertain = new Set<string>()

/**
 * Either path is about to type answer `key` into its Question card; false when the other one is
 * typing it right now. Check and claim run without an await between them, so only one types.
 */
export function beginCardTyping(key: string): boolean {
  if (typing.has(key)) {
    return false
  }
  typing.add(key)
  return true
}

/** `uncertain`: the window did not confirm, so the keys may have landed. */
export function endCardTyping(key: string, outcome: 'typed' | 'uncertain' | 'refused'): void {
  typing.delete(key)
  if (outcome === 'typed') {
    typed.add(key)
  } else if (outcome === 'uncertain') {
    uncertain.add(key)
  }
}

export function cardTyped(key: string): boolean {
  return typed.has(key)
}

export function cardTypingUncertain(key: string): boolean {
  return uncertain.has(key)
}

/** Either path is typing it, typed it, or may have: the other leaves it alone. */
export function cardTouched(key: string): boolean {
  return typing.has(key) || typed.has(key) || uncertain.has(key)
}

/** Only refusals that say nothing went in are clean; anything else may have typed keys. */
export function cardTypingOutcome(
  outcome: { delivered: true } | { delivered: false; error: string }
): 'typed' | 'uncertain' | 'refused' {
  if (outcome.delivered) {
    return 'typed'
  }
  return /nothing was (typed|sent)|cannot type OmniOS answers/.test(outcome.error)
    ? 'refused'
    : 'uncertain'
}

export function resetAnswerHandoverForTests(): void {
  claimer = null
  typing.clear()
  typed.clear()
  uncertain.clear()
}
