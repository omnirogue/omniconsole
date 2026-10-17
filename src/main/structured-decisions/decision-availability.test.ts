import { describe, expect, it } from 'vitest'
import {
  isStructuredDecisionAvailable,
  setStructuredDecisionAvailability
} from './decision-availability'

describe('structured decision host capability availability', () => {
  it('defaults unavailable until the implementation is explicitly installed', () => {
    expect(isStructuredDecisionAvailable({})).toBe(false)
  })

  it('isolates installation and removal by exact runtime identity', () => {
    const first = { id: 'same-id' }
    const second = { id: 'same-id' }
    setStructuredDecisionAvailability(first, true)
    expect(isStructuredDecisionAvailable(first)).toBe(true)
    expect(isStructuredDecisionAvailable(second)).toBe(false)
    setStructuredDecisionAvailability(second, true)
    setStructuredDecisionAvailability(first, false)
    expect(isStructuredDecisionAvailable(first)).toBe(false)
    expect(isStructuredDecisionAvailable(second)).toBe(true)
    setStructuredDecisionAvailability(second, false)
  })

  it('is idempotent without advertising any unrelated host', () => {
    const runtime = {}
    setStructuredDecisionAvailability(runtime, false)
    setStructuredDecisionAvailability(runtime, true)
    setStructuredDecisionAvailability(runtime, true)
    expect(isStructuredDecisionAvailable(runtime)).toBe(true)
    setStructuredDecisionAvailability(runtime, false)
    setStructuredDecisionAvailability(runtime, false)
    expect(isStructuredDecisionAvailable(runtime)).toBe(false)
    expect(isStructuredDecisionAvailable({})).toBe(false)
  })
})
