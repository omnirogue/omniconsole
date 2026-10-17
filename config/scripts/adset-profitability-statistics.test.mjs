import { describe, expect, it } from 'vitest'

import {
  anytimeConversionInterval,
  betaQuantile,
  betaSurvival,
  evaluateAdsetProfitability,
  exactBinomialProfitabilityTest
} from './adset-profitability-statistics.mjs'

function input(overrides = {}) {
  return {
    maturedClicks: 1000,
    purchases: 100,
    costPerClick: 2,
    netContributionPerPurchase: 40,
    evidenceAgeSeconds: 0,
    maxEvidenceAgeSeconds: 300,
    matureCohort: true,
    attributionConsistent: true,
    stationary: true,
    independentOutcomes: true,
    constantCost: true,
    comparableWindow: true,
    ...overrides
  }
}

describe('integer beta probabilities', () => {
  it.each([0, 0.001, 0.05, 0.25, 0.5, 0.99, 1])(
    'matches the uniform survival at %s',
    (threshold) => {
      expect(betaSurvival(1, 1, threshold)).toBeCloseTo(1 - threshold, 13)
    }
  )

  it('matches analytic polynomial distributions and symmetry', () => {
    expect(betaSurvival(2, 1, 0.25)).toBeCloseTo(0.9375, 13)
    expect(betaSurvival(1, 2, 0.25)).toBeCloseTo(0.5625, 13)
    expect(betaSurvival(2, 2, 0.25)).toBeCloseTo(0.84375, 13)
    expect(betaSurvival(1000, 1000, 0.5)).toBeCloseTo(0.5, 9)
    expect(betaSurvival(13, 98, 0.08) + betaSurvival(98, 13, 0.92)).toBeCloseTo(1, 11)
  })

  it('is monotonic in outcomes and threshold without negative or non-finite tails', () => {
    expect(betaSurvival(12, 90, 0.05)).toBeGreaterThan(betaSurvival(11, 91, 0.05))
    expect(betaSurvival(12, 90, 0.05)).toBeGreaterThan(betaSurvival(12, 90, 0.1))
    for (const probability of [betaSurvival(1, 10000, 0.95), betaSurvival(10000, 1, 0.001)]) {
      expect(Number.isFinite(probability)).toBe(true)
      expect(probability).toBeGreaterThanOrEqual(0)
      expect(probability).toBeLessThanOrEqual(1)
    }
  })

  it.each([
    [0, 1, 0.5],
    [1, 0, 0.5],
    [1.5, 2, 0.5],
    [1, 1, -0.1],
    [1, 1, 1.1],
    [1, 1, Number.NaN],
    [20000, 20000, 0.5],
    [Infinity, 1, 0.5]
  ])('rejects impossible parameters %j', (...parameters) => {
    expect(() => betaSurvival(...parameters)).toThrow('invalid_beta_parameters')
  })

  it('inverts the CDF for declared credible intervals', () => {
    expect(betaQuantile(1, 1, 0.025)).toBeCloseTo(0.025, 12)
    expect(betaQuantile(1, 1, 0.975)).toBeCloseTo(0.975, 12)
    expect(betaQuantile(2, 1, 0.25)).toBeCloseTo(0.5, 12)
    expect(betaQuantile(20, 40, 0)).toBe(0)
    expect(betaQuantile(20, 40, 1)).toBe(1)
    expect(() => betaQuantile(1, 1, Number.NaN)).toThrow('invalid_beta_quantile')
    expect(() => betaQuantile(0, 1, 0.5)).toThrow('invalid_beta_parameters')
  })
})

describe('sequential campaign error budgets', () => {
  it('widens the interval for more monitored ad sets and repeated looks', () => {
    const one = anytimeConversionInterval({ clicks: 1000, purchases: 100, campaignAdsets: 1 })
    const three = anytimeConversionInterval({ clicks: 1000, purchases: 100, campaignAdsets: 3 })
    const repeated = anytimeConversionInterval({
      clicks: 1000,
      purchases: 100,
      campaignAdsets: 3,
      lookIndex: 100
    })
    expect(one.alphaAtLook).toBeCloseTo(0.025, 13)
    expect(three.alphaAtLook).toBeCloseTo(0.05 / 6, 13)
    expect(three.lowerConversionRate).toBeLessThan(one.lowerConversionRate)
    expect(repeated.lowerConversionRate).toBeLessThan(three.lowerConversionRate)
    expect(repeated.upperConversionRate).toBeGreaterThan(three.upperConversionRate)
  })

  it('sums both tails and all ad sets within the campaign family allowance', () => {
    let spent = 0
    for (let lookIndex = 1; lookIndex <= 100; lookIndex += 1) {
      const interval = anytimeConversionInterval({ clicks: 100, purchases: 10, lookIndex })
      spent += interval.alphaAtLook * 3
    }
    expect(spent).toBeCloseTo((0.05 * 100) / 101, 12)
    expect(spent).toBeLessThan(0.05)
  })

  it('computes exact binomial boundary and middle tails', () => {
    const common = { clicks: 10, breakEvenConversionRate: 0.5, campaignAdsets: 1 }
    const all = exactBinomialProfitabilityTest({ ...common, purchases: 10 })
    const none = exactBinomialProfitabilityTest({ ...common, purchases: 0 })
    const half = exactBinomialProfitabilityTest({ ...common, purchases: 5 })
    expect(all.profitablePValue).toBeCloseTo(1 / 1024, 13)
    expect(all.unprofitablePValue).toBe(1)
    expect(all.decision).toBe('PROFITABLE')
    expect(none.profitablePValue).toBe(1)
    expect(none.unprofitablePValue).toBeCloseTo(1 / 1024, 13)
    expect(none.decision).toBe('UNPROFITABLE')
    expect(half.profitablePValue).toBeCloseTo(0.623046875, 13)
    expect(half.unprofitablePValue).toBeCloseTo(0.623046875, 13)
    expect(half.decision).toBe('INCONCLUSIVE')
    expect(all.alphaPerTailAtLook).toBeCloseTo(0.0125, 13)
  })

  it.each([
    { clicks: 0 },
    { clicks: 10001 },
    { purchases: -1 },
    { purchases: 101 },
    { lookIndex: 0 },
    { lookIndex: 10001 },
    { familyAlpha: 1 },
    { campaignAdsets: 0 }
  ])('rejects invalid monitoring input %j', (overrides) => {
    expect(() => anytimeConversionInterval({ clicks: 100, purchases: 10, ...overrides })).toThrow(
      'invalid_anytime_parameters'
    )
  })
})

describe('safe modeled profitability', () => {
  it('computes profit using net contribution, not revenue or prose confidence', () => {
    const result = evaluateAdsetProfitability(input())
    expect(result.evidenceReady).toBe(true)
    expect(result.breakEvenConversionRate).toBe(0.05)
    expect(result.observed).toMatchObject({
      conversionRate: 0.1,
      spend: 2000,
      costPerPurchase: 20,
      contributionRoas: 2,
      netContributionAfterAdSpend: 2000
    })
    expect(result.posterior).toEqual({ alpha: 101, beta: 901 })
    expect(result.posteriorProfitProbability).toBeGreaterThan(0.99)
    expect(result.posteriorDecision).toBe('PROFITABLE')
    expect(result.anytime.decision).toBe('INCONCLUSIVE')
    expect(result.anytimeExact.decision).toBe('PROFITABLE')
    expect(result.authorization).toBe('NONE')
    expect(result.posteriorInterval).toBeNull()
    expect(result.interpretation).toContain('not calibrated real-world confidence')
  })

  it('reports optional equal-tail posterior intervals without relabeling them confidence bounds', () => {
    const result = evaluateAdsetProfitability(input({ includePosteriorInterval: true }))
    expect(result.posteriorInterval.level).toBe(0.95)
    expect(result.posteriorInterval.lowerConversionRate).toBeLessThan(0.1)
    expect(result.posteriorInterval.upperConversionRate).toBeGreaterThan(0.1)
    expect(result.posteriorInterval.lowerConversionRate).toBeGreaterThan(
      result.anytime.lowerConversionRate
    )
  })

  it.each([
    { netContributionPerPurchase: null },
    { netContributionPerPurchase: 0 },
    { costPerClick: null },
    { maturedClicks: 0 },
    { maturedClicks: 10001 },
    { purchases: 1001 },
    { purchases: null },
    { matureCohort: false },
    { attributionConsistent: false },
    { stationary: false },
    { independentOutcomes: false },
    { constantCost: false },
    { comparableWindow: false },
    { evidenceAgeSeconds: null },
    { evidenceAgeSeconds: -1 },
    { evidenceAgeSeconds: 301 },
    { prior: { alpha: 0, beta: 1 } },
    { prior: null },
    { posteriorThreshold: 1 },
    { lookIndex: 0 },
    { campaignAdsets: 0 },
    { familyAlpha: null },
    { costPerClick: 1e308, netContributionPerPurchase: 1e308 }
  ])('abstains rather than fabricating precision for %j', (overrides) => {
    const result = evaluateAdsetProfitability(input(overrides))
    expect(result.evidenceReady).toBe(false)
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(result.posteriorProfitProbability).toBeNull()
    expect(result.posteriorDecision).toBe('INCONCLUSIVE')
    expect(result.anytimeExact.decision).toBe('INCONCLUSIVE')
    expect(result.authorization).toBe('NONE')
  })

  it('handles missing input, zero conversions and impossible profitable unit economics', () => {
    expect(evaluateAdsetProfitability(null).reasons).toEqual(['missing_input'])
    const none = evaluateAdsetProfitability(input({ purchases: 0 }))
    expect(none.observed.costPerPurchase).toBeNull()
    expect(none.posteriorDecision).toBe('UNPROFITABLE')
    const impossible = evaluateAdsetProfitability(input({ costPerClick: 50 }))
    expect(impossible.posteriorProfitProbability).toBe(0)
    expect(impossible.posteriorDecision).toBe('UNPROFITABLE')
  })

  it('makes prior sensitivity visible without silently replacing the declared prior', () => {
    const weak = evaluateAdsetProfitability(input({ maturedClicks: 25, purchases: 0 }))
    const optimistic = evaluateAdsetProfitability(
      input({ maturedClicks: 25, purchases: 0, prior: { alpha: 20, beta: 80 } })
    )
    expect(optimistic.posteriorProfitProbability).toBeGreaterThan(weak.posteriorProfitProbability)
    expect(weak.prior).toEqual({ alpha: 1, beta: 1 })
    expect(optimistic.prior).toEqual({ alpha: 20, beta: 80 })
  })
})
