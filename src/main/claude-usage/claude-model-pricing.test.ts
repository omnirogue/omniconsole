import { describe, expect, it } from 'vitest'
import { estimateCostUsd } from './claude-model-pricing'

describe('estimateCostUsd cache-write TTL rates', () => {
  it('bills 5-minute cache writes at 1.25x base input', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(6.25)
  })

  it('keeps the legacy five-argument call billing every write at the 5-minute rate', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000)).toBeCloseTo(6.25)
  })

  it('bills 1-hour cache writes at 2x base input', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(10)
  })

  it('splits a mixed write bucket without double-billing the 1-hour share', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000_000, 400_000)).toBeCloseTo(7.75)
  })

  it('clamps a 1-hour count that exceeds the reported write total', () => {
    expect(estimateCostUsd('claude-opus-5', 0, 0, 0, 1_000, 5_000)).toBeCloseTo(0.01)
  })

  it('applies the long-context tier to 1-hour writes', () => {
    expect(estimateCostUsd('claude-sonnet-4-6', 0, 0, 0, 400_000, 400_000)).toBeCloseTo(3.6)
  })

  it('prices at base rates when long-context tiers are off for a multi-request total', () => {
    expect(
      estimateCostUsd('claude-sonnet-4-6', 0, 0, 0, 400_000, 400_000, { longContextTiers: false })
    ).toBeCloseTo(2.4)
  })

  it('shares one long-context allowance across both TTL buckets', () => {
    // 400k writes split evenly: 200k @ (3.75/7.5) and 200k @ (6/12), each tier
    // getting half of the 200k allowance.
    expect(estimateCostUsd('claude-sonnet-4-6', 0, 0, 0, 400_000, 200_000)).toBeCloseTo(2.925)
  })

  it('never lowers a long-context estimate as writes shift from 5-minute to 1-hour', () => {
    const costs = [0, 50_000, 100_000, 200_000, 300_000, 400_000].map((write1h) =>
      estimateCostUsd('claude-sonnet-4-6', 0, 0, 0, 400_000, write1h)!
    )
    for (let index = 1; index < costs.length; index++) {
      expect(costs[index]).toBeGreaterThan(costs[index - 1])
    }
  })

  it('still returns null for unknown models', () => {
    expect(estimateCostUsd('gpt-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeNull()
  })
})

// Published Claude Sonnet 5 rates (platform.claude.com/docs/en/about-claude/pricing):
// $2 base input, $10 output, $0.20 cache hit, $2.50 5m write, $4 1h write per MTok.
// The $2/$10 launch price, announced as introductory through 2026-08-31, is now the
// standard price — the scheduled 2026-09-01 rise to $3/$15 was cancelled — so the rate
// is date-independent.
describe('estimateCostUsd Claude Sonnet 5 rates', () => {
  it('bills base input at $2/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(2)
  })

  it('bills output at $10/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 0, 1_000_000, 0, 0, 0)).toBeCloseTo(10)
  })

  it('bills cache hits at $0.20/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 0, 0, 1_000_000, 0, 0)).toBeCloseTo(0.2)
  })

  it('bills 5-minute cache writes at $2.50/MTok and 1-hour writes at $4/MTok', () => {
    expect(estimateCostUsd('claude-sonnet-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(2.5)
    expect(estimateCostUsd('claude-sonnet-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(4)
  })

  it('keeps the full 1M window at flat rates with no long-context tier', () => {
    expect(estimateCostUsd('claude-sonnet-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(
      estimateCostUsd('claude-sonnet-5', 500_000, 0, 0, 0, 0)! * 2
    )
  })
})

// Claude Sonnet 5.5 list rates (platform.claude.com/docs/en/about-claude/pricing, read 12 Oct 2026):
// Sonnet 5's $2 input, $10 output and cache writes, but cache hits at 0.05x input, $0.10/MTok.
describe('estimateCostUsd Claude Sonnet 5.5 rates', () => {
  it('bills cache hits at $0.10/MTok, half the Sonnet 5 rate', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-sonnet-5.5', 'claude-sonnet-5-5-20261001']) {
      expect(estimateCostUsd(model, 0, 0, 1_000_000, 0, 0)).toBeCloseTo(0.1)
    }
    expect(estimateCostUsd('claude-sonnet-5', 0, 0, 1_000_000, 0, 0)).toBeCloseTo(0.2)
  })

  it('bills input, output and cache writes at the Sonnet 5 rates', () => {
    expect(estimateCostUsd('claude-sonnet-5-5', 1_000_000, 1_000_000, 0, 0, 0)).toBeCloseTo(12)
    expect(estimateCostUsd('claude-sonnet-5-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(2.5)
    expect(estimateCostUsd('claude-sonnet-5-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(4)
  })
})

// Claude Haiku 5.5 list rates for prompts up to 100k tokens (bench/RESULTS.md, read 10 Oct 2026):
// $0.10 input, $0.50 output, $0.01 cache hit, $0.125 5m write per MTok; 1h write at 2x input.
describe('estimateCostUsd Claude Haiku 5.5 rates', () => {
  it('bills input, output and cache hits at $0.10, $0.50 and $0.01/MTok', () => {
    expect(estimateCostUsd('claude-haiku-5-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(0.1)
    expect(estimateCostUsd('claude-haiku-5-5', 0, 1_000_000, 0, 0, 0)).toBeCloseTo(0.5)
    expect(estimateCostUsd('claude-haiku-5-5', 0, 0, 1_000_000, 0, 0)).toBeCloseTo(0.01)
  })

  it('bills 5-minute cache writes at $0.125/MTok and 1-hour writes at $0.20/MTok', () => {
    expect(estimateCostUsd('claude-haiku-5-5', 0, 0, 0, 1_000_000, 0)).toBeCloseTo(0.125)
    expect(estimateCostUsd('claude-haiku-5-5', 0, 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(0.2)
  })

  it('matches dotted, prefixed and dated IDs without taking Haiku 4.5 rates', () => {
    for (const model of [
      'claude-haiku-5.5',
      'anthropic/claude-haiku-5-5',
      'claude-haiku-5-5-20261001'
    ]) {
      expect(estimateCostUsd(model, 1_000_000, 0, 0, 0, 0)).toBeCloseTo(0.1)
    }
    expect(estimateCostUsd('claude-haiku-4-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(1)
  })

  it('stays flat past 100k tokens: the per-request long-prompt rate is not modelled', () => {
    expect(estimateCostUsd('claude-haiku-5-5', 1_000_000, 0, 0, 0, 0)).toBeCloseTo(
      estimateCostUsd('claude-haiku-5-5', 50_000, 0, 0, 0, 0)! * 20
    )
  })
})

describe('estimateCostUsd against a Claude CLI bill', () => {
  // T1 brief/a0: the CLI reported $0.4625705; every cache write used the 1-hour TTL.
  it('reproduces the bill only when 1-hour writes are priced at the 1-hour rate', () => {
    expect(estimateCostUsd('claude-opus-5', 12, 5607, 89311, 27768, 27768)).toBeCloseTo(
      0.4625705,
      9
    )
    expect(estimateCostUsd('claude-opus-5', 12, 5607, 89311, 27768)).toBeLessThan(0.4)
  })
})
