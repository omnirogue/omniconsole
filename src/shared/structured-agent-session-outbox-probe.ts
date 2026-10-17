/**
 * How long the structured-mode outbox waits before re-issuing an unconfirmed
 * send, and when it stops asking.
 *
 * Re-issuing the same envelope is idempotent (the operation ledger replays a
 * recorded outcome), which is why probing is safe at all. But probing forever
 * leaves a delivery nobody ever decides about: the queue looks busy and the
 * person is never told. After the ceiling the entry stays `unconfirmed` and needs
 * their decision — Retry re-arms it from zero, so the ceiling is not a dead end.
 */

export const STRUCTURED_OUTBOX_PROBE_BASE_DELAY_MS = 1_000
export const STRUCTURED_OUTBOX_PROBE_MAX_DELAY_MS = 16_000

/** Probes before the delivery becomes the person's decision. */
export const STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING = 12

export const STRUCTURED_OUTBOX_UNCONFIRMED_DECISION_MESSAGE =
  'Message delivery is still unconfirmed after repeated checks. Use Retry to send it again, or remove it from the queue.'

/** Null once `attempts` has reached the ceiling: stop probing and ask the person. */
export function nextStructuredOutboxProbeDelayMs(attempts: number): number | null {
  const taken = Math.max(0, Math.floor(attempts))
  if (taken >= STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING) {
    return null
  }
  return Math.min(
    STRUCTURED_OUTBOX_PROBE_BASE_DELAY_MS * 2 ** taken,
    STRUCTURED_OUTBOX_PROBE_MAX_DELAY_MS
  )
}
