import { describe, expect, it } from 'vitest'

import {
  PROFITABILITY_CHECKPOINTS,
  PROFITABILITY_SCENARIOS,
  runProfitabilitySimulation
} from './adset-profitability-simulation.mjs'

describe('bounded synthetic profitability simulation', () => {
  it('produces deterministic aggregate evidence with explicit assumptions', () => {
    const options = { seed: 13, campaignsPerScenario: 2, scenarioIds: ['clear_winner'] }
    const report = runProfitabilitySimulation(options)
    expect(runProfitabilitySimulation(options)).toEqual(report)
    expect(report).toMatchObject({
      seed: 13,
      campaignCount: 2,
      adsetCount: 6,
      kind: 'synthetic_adset_profitability_simulation',
      campaignsPerScenario: 2
    })
    expect(Object.isFrozen(report)).toBe(true)
    expect(Object.isFrozen(report.scenarios[0].arms[0])).toBe(true)
    expect(report.scenarios[0].arms).toHaveLength(7)
    expect(report.scenarios[0].arms.map(({ arm }) => arm)).toContain('anytime_exact_binomial_95')
    for (const arm of report.scenarios[0].arms) {
      expect(arm.denominators).toEqual({
        campaigns: 2,
        adsets: 6,
        profitableAdsets: 2,
        unprofitableAdsets: 4
      })
      expect(arm.campaignFalseProfitRate).toBe(arm.campaignsWithFalseProfitClaim / 2)
      expect(arm.profitClaims).toBeLessThanOrEqual(6)
      expect(arm.falseProfitClaims).toBeLessThanOrEqual(arm.profitClaims)
      expect(arm.firstProfitMaturedClicks.count).toBe(arm.campaignsWithAnyProfitClaim)
      expect(arm).not.toHaveProperty('rawObservations')
    }
    const bins = report.scenarios[0].finalLookPosteriorBins
    expect(bins.uniform.reduce((total, bin) => total + bin.count, 0)).toBe(6)
    expect(bins.optimistic.reduce((total, bin) => total + bin.count, 0)).toBe(6)
  })

  it('fails closed when drift is known instead of pretending past data establishes future profit', () => {
    const report = runProfitabilitySimulation({
      campaignsPerScenario: 1,
      scenarioIds: ['known_drift_abstains']
    })
    expect(report.scenarios[0].assumptionsHold).toBe(false)
    for (const arm of report.scenarios[0].arms) {
      expect(arm.profitClaims).toBe(0)
      expect(arm.unprofitableClaims).toBe(0)
      expect(arm.abstentionRate).toBe(1)
      expect(arm.firstProfitMaturedClicks).toEqual({
        count: 0,
        mean: null,
        median: null,
        p90: null
      })
    }
  })

  it('excludes pending conversions from the denominator but includes pending spend in exposure', () => {
    const report = runProfitabilitySimulation({
      campaignsPerScenario: 1,
      scenarioIds: ['delayed_conversions']
    })
    expect(report.scenarios[0].maturityLagClicks).toBe(50)
    for (const arm of report.scenarios[0].arms) {
      if (arm.firstProfitMaturedClicks.count) {
        expect(arm.firstProfitDeliveredClicks.mean - arm.firstProfitMaturedClicks.mean).toBe(50)
        expect(arm.firstProfitCampaignSpend.mean).toBe(arm.firstProfitDeliveredClicks.mean * 6)
      }
    }
  })

  it('freezes the intended checkpoint and scenario coverage without running the full study', () => {
    expect(PROFITABILITY_CHECKPOINTS).toEqual([25, 50, 100, 200, 400, 800])
    expect(PROFITABILITY_SCENARIOS.map(({ id }) => id)).toEqual([
      'clear_winner',
      'weak_winner',
      'all_unprofitable',
      'near_break_even',
      'conditioned_early_luck',
      'delayed_conversions',
      'unflagged_drift',
      'known_drift_abstains'
    ])
    expect(PROFITABILITY_SCENARIOS.filter(({ assumptionsHold }) => assumptionsHold)).toHaveLength(5)
  })

  it.each([
    { seed: -1 },
    { seed: 0x100000000 },
    { seed: Number.NaN },
    { campaignsPerScenario: 0 },
    { campaignsPerScenario: 1001 },
    { campaignsPerScenario: 1.5 },
    { scenarioIds: [] },
    { scenarioIds: ['missing'] },
    { scenarioIds: ['clear_winner', 'clear_winner'] },
    { scenarioIds: 'clear_winner' }
  ])('rejects unbounded or unknown configuration before drawing samples %j', (options) => {
    expect(() => runProfitabilitySimulation(options)).toThrow('invalid_profitability_simulation')
  })
})
