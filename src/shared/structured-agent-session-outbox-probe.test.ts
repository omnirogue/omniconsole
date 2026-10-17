import { describe, expect, it } from 'vitest'
import {
  nextStructuredOutboxProbeDelayMs,
  STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING,
  STRUCTURED_OUTBOX_PROBE_MAX_DELAY_MS
} from './structured-agent-session-outbox-probe'

describe('structured outbox probe policy', () => {
  it('backs off exponentially up to the rate cap', () => {
    expect(nextStructuredOutboxProbeDelayMs(0)).toBe(1_000)
    expect(nextStructuredOutboxProbeDelayMs(1)).toBe(2_000)
    expect(nextStructuredOutboxProbeDelayMs(4)).toBe(16_000)
    expect(nextStructuredOutboxProbeDelayMs(5)).toBe(STRUCTURED_OUTBOX_PROBE_MAX_DELAY_MS)
  })

  it('stops asking once the attempts are spent', () => {
    expect(nextStructuredOutboxProbeDelayMs(STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING - 1)).toBe(
      STRUCTURED_OUTBOX_PROBE_MAX_DELAY_MS
    )
    expect(nextStructuredOutboxProbeDelayMs(STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING)).toBeNull()
    expect(nextStructuredOutboxProbeDelayMs(STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING + 5)).toBeNull()
  })

  it('treats a malformed attempt count as the first attempt', () => {
    expect(nextStructuredOutboxProbeDelayMs(-3)).toBe(1_000)
    expect(nextStructuredOutboxProbeDelayMs(0.5)).toBe(1_000)
  })
})
