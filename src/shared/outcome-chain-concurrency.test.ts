import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_DEFAULT,
  OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_MIN,
  resolveOutcomeChainMaxConcurrentAgents
} from './outcome-chain-concurrency'

describe('resolveOutcomeChainMaxConcurrentAgents', () => {
  it('defaults to three agents, including for a fresh profile', () => {
    expect(OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_DEFAULT).toBe(3)
    expect(resolveOutcomeChainMaxConcurrentAgents(undefined)).toBe(3)
    expect(resolveOutcomeChainMaxConcurrentAgents(getDefaultSettings('/tmp'))).toBe(3)
  })

  it('keeps whole numbers inside one to eight and clamps the rest', () => {
    expect(resolveOutcomeChainMaxConcurrentAgents({ outcomeChainMaxConcurrentAgents: 1 })).toBe(1)
    expect(resolveOutcomeChainMaxConcurrentAgents({ outcomeChainMaxConcurrentAgents: 8 })).toBe(8)
    expect(resolveOutcomeChainMaxConcurrentAgents({ outcomeChainMaxConcurrentAgents: 0 })).toBe(1)
    expect(resolveOutcomeChainMaxConcurrentAgents({ outcomeChainMaxConcurrentAgents: 50 })).toBe(8)
  })

  it('uses the default only when no value is stored at all', () => {
    expect(resolveOutcomeChainMaxConcurrentAgents({})).toBe(3)
    expect(
      resolveOutcomeChainMaxConcurrentAgents({ outcomeChainMaxConcurrentAgents: undefined })
    ).toBe(3)
  })

  it.each([2.5, Number.NaN, Number.POSITIVE_INFINITY, '4', '1', null])(
    'fails closed to one agent for a present but malformed value %s',
    (value) => {
      // A corrupt or version-skewed cap is not authority to fan out to the healthy default.
      expect(
        resolveOutcomeChainMaxConcurrentAgents({
          outcomeChainMaxConcurrentAgents: value as unknown as number
        })
      ).toBe(OUTCOME_CHAIN_MAX_CONCURRENT_AGENTS_MIN)
    }
  )
})
