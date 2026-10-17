import { describe, expect, it } from 'vitest'
import { snapshotDecisionRequest } from '../../src/shared/structured-decisions.ts'
import {
  ADSET_PROFITABILITY_CASES,
  ADSET_PROFITABILITY_POLICY,
  evaluateAdsetProfitabilityReference,
  numericAdsetProfitabilityDecision
} from './typesafe-adset-profitability-corpus.mjs'
import { ADSET_KEYS } from './typesafe-adset-profitability-fixtures.mjs'

const requestFor = (item) => ({
  capability: `evaluation_${item.task}`,
  state: item.state,
  questions: item.questions,
  model: 'jev-1.13.0'
})
const family = (name) =>
  ADSET_PROFITABILITY_CASES.filter(({ familyId }) => familyId === `adset-${name}`)
const values = (item) =>
  Object.fromEntries(Object.entries(item.expected).map(([key, answer]) => [key, answer.value]))

describe('synthetic campaign adset profitability interpretation corpus', () => {
  it('freezes 48 policy examples across 16 related-variant families with disjoint splits', () => {
    expect(ADSET_PROFITABILITY_CASES).toHaveLength(48)
    expect(ADSET_PROFITABILITY_CASES.filter(({ split }) => split === 'development')).toHaveLength(
      12
    )
    expect(ADSET_PROFITABILITY_CASES.filter(({ split }) => split === 'holdout')).toHaveLength(36)
    expect(new Set(ADSET_PROFITABILITY_CASES.map(({ id }) => id)).size).toBe(48)
    expect(new Set(ADSET_PROFITABILITY_CASES.map(({ state }) => JSON.stringify(state))).size).toBe(
      48
    )
    const families = new Map()
    for (const item of ADSET_PROFITABILITY_CASES) {
      expect(item.origin).toBe('authored_synthetic')
      expect(item.task).toBe('adset_profitability_selection')
      expect(item.id).toMatch(/^[a-z0-9-]+$/)
      expect(item.familyId).toMatch(/^[a-z0-9-]+$/)
      expect(item.rationale.length).toBeGreaterThan(30)
      expect(Object.isFrozen(item.expected)).toBe(true)
      expect(Object.values(item.expected).every(Object.isFrozen)).toBe(true)
      if (!families.has(item.familyId)) {
        families.set(item.familyId, new Set())
      }
      families.get(item.familyId).add(item.split)
    }
    expect(families.size).toBe(16)
    expect([...families.values()].every((splits) => splits.size === 1)).toBe(true)
  })

  it.each(ADSET_PROFITABILITY_CASES)(
    'has valid bounded label-free requests and independently recomputed policy agreement: $id',
    (item) => {
      const request = requestFor(item)
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(16_384)
      expect(snapshotDecisionRequest(request)).toEqual(request)
      expect(Object.keys(request).sort()).toEqual(['capability', 'model', 'questions', 'state'])
      expect(request).not.toHaveProperty('expected')
      expect(request).not.toHaveProperty('rationale')
      expect(Object.keys(item.expected).sort()).toEqual(['readiness', 'winner'])
      for (const [key, expected] of Object.entries(item.expected)) {
        expect(item.questions[key].type).toBe('choice')
        expect(Object.keys(item.questions[key].criteria)).toContain(expected.value)
      }
      const response = evaluateAdsetProfitabilityReference(request)
      expect(response.status).toBe('success')
      expect(response.answers).toEqual(item.expected)
      expect(response.estimatedCostUsd).toBe(0)
      expect(response.elapsedMs).toBeGreaterThanOrEqual(0)
      expect(numericAdsetProfitabilityDecision(item.state)).toEqual(values(item))
    }
  )

  it('separates probability of profit, probability of best, sequential confidence and authority', () => {
    for (const { state } of ADSET_PROFITABILITY_CASES) {
      expect(state.simulationPolicy).toEqual(ADSET_PROFITABILITY_POLICY)
      expect(state.simulationPolicy.rankingMeaning).toContain('NOT probability of being best')
      expect(state.executionAuthorization).toBe('NONE')
      expect(state.ranking.probabilityOfBeingBest).toBeNull()
      expect(state.ranking.probabilityOfBeingBestStatus).toBe('NOT_ESTIMATED')
      expect(state.ranking.counterfactualIncrementalProfitStatus).toBe('NOT_ESTIMATED')
      expect(state.adsets.map(({ key }) => key)).toEqual(ADSET_KEYS)
      for (const { computed } of state.adsets) {
        expect(computed.authorization).toBe('NONE')
        expect(computed.posteriorThresholdMet).toBe(
          computed.evidenceReady && computed.posteriorProfitProbability >= 0.95
        )
        expect(computed.anytimeProfitable).toBe(
          computed.evidenceReady && computed.anytime.decision === 'PROFITABLE'
        )
      }
    }
  })

  it('allows a unique relative winner while rejecting absolute confidence for negative or sparse cohorts', () => {
    for (const name of [
      'development-all-negative',
      'development-sparse',
      'informative-prior-without-data',
      'many-repeated-looks'
    ]) {
      for (const item of family(name)) {
        expect(ADSET_KEYS).toContain(item.expected.winner.value)
        expect(item.expected.readiness.value).toBe('OBSERVE')
        const winner = item.state.adsets.find(({ key }) => key === item.expected.winner.value)
        expect(winner.computed.anytimeProfitable).toBe(false)
      }
    }
    for (const item of family('development-all-negative')) {
      expect(
        item.state.adsets.every(({ computed }) => computed.posteriorThresholdMet === false)
      ).toBe(true)
    }
    for (const item of family('informative-prior-without-data')) {
      expect(item.state.adsets.every(({ source }) => source.purchases === 0)).toBe(true)
      expect(item.state.adsets.some(({ computed }) => computed.posteriorThresholdMet)).toBe(true)
    }
  })

  it('requires all business guards, maturity, valid economics and model assumptions', () => {
    const groups = [
      'unknown-unit-economics',
      'unmatured-outcome-cohorts',
      'purchase-event-mapping',
      'incompatible-historical-baseline',
      'adaptive-delivery-confounding',
      'evidence-freshness',
      'future-stationarity-and-cost'
    ]
    for (const name of groups) {
      expect(family(name)).toHaveLength(3)
      for (const item of family(name)) {
        expect(values(item)).toEqual({ winner: 'INSUFFICIENT_EVIDENCE', readiness: 'OBSERVE' })
        const guardFailure = Object.values(item.state.campaign.guards).includes(false)
        const statisticalFailure = item.state.adsets.some(({ computed }) => !computed.evidenceReady)
        expect(guardFailure || statisticalFailure).toBe(true)
      }
    }
  })

  it('does not manufacture a probability-best ranking from near-one profit probabilities', () => {
    for (const item of [
      ...family('development-identical-ties'),
      ...family('profit-probability-not-expected-profit')
    ]) {
      expect(item.state.ranking.highestProfitProbabilityCandidates).toHaveLength(2)
      expect(values(item)).toEqual({ winner: 'TIE', readiness: 'OBSERVE' })
    }
    for (const item of family('profit-probability-not-expected-profit')) {
      const best = item.state.adsets.filter(({ key }) =>
        item.state.ranking.highestProfitProbabilityCandidates.includes(key)
      )
      expect(best[0].computed.observed.posteriorExpectedNetContributionPerClick).not.toBe(
        best[1].computed.observed.posteriorExpectedNetContributionPerClick
      )
    }
  })

  it('keeps baseline context separate from the prior and supports dimensionally correct economic rescaling', () => {
    for (const name of [
      'verified-cost-margin-rescaling',
      'separate-baseline-context',
      'development-mature-clear'
    ]) {
      for (const item of family(name)) {
        expect(item.expected.readiness.value).toBe('READY_FOR_HUMAN_REVIEW')
        for (const { source, computed } of item.state.adsets) {
          expect(source.prior).toEqual({ alpha: 1, beta: 1 })
          expect(computed.breakEvenConversionRate).toBe(0.05)
        }
      }
    }
    const contexts = family('separate-baseline-context').map(
      ({ state }) => state.campaign.baseline.purchaseConversionRate
    )
    expect(new Set(contexts).size).toBe(3)
  })

  it('recomputes numerical evidence independently instead of trusting forged presentation flags', () => {
    const sample = family('development-all-negative')[0]
    const state = structuredClone(sample.state)
    state.ranking.highestProfitProbabilityCandidates = ['ADSET_C']
    for (const adset of state.adsets) {
      adset.computed.posteriorProfitProbability = 1
      adset.computed.posteriorThresholdMet = true
      adset.computed.anytimeProfitable = true
      adset.computed.anytime.decision = 'PROFITABLE'
    }
    expect(numericAdsetProfitabilityDecision(state)).toEqual(values(sample))
  })

  it('fails safely on malformed groups, omitted guards and changed confidence plans', () => {
    const sample = family('development-mature-clear')[0]
    const mutations = [
      (state) => {
        state.adsets.pop()
      },
      (state) => {
        state.adsets[1].key = 'ADSET_A'
      },
      (state) => {
        delete state.campaign.guards.purchaseEventVerified
      },
      (state) => {
        state.adsets[0].source.campaignAdsets = 1
      },
      (state) => {
        state.adsets[0].source.familyAlpha = 0.49
      },
      (state) => {
        state.adsets[0].source.posteriorThreshold = 0.8
      },
      (state) => {
        state.adsets[0].source.maxEvidenceAgeSeconds = 99999
      },
      (state) => {
        state.simulationPolicy.version = 'unknown'
      }
    ]
    for (const mutate of mutations) {
      const state = structuredClone(sample.state)
      mutate(state)
      expect(numericAdsetProfitabilityDecision(state)).toEqual({
        winner: 'INSUFFICIENT_EVIDENCE',
        readiness: 'OBSERVE'
      })
    }
    const skipped = evaluateAdsetProfitabilityReference({ capability: 'another_task' })
    const failed = evaluateAdsetProfitabilityReference({ ...requestFor(sample), questions: {} })
    expect(skipped.status).toBe('skipped')
    expect(failed).toMatchObject({ status: 'error', errorCode: 'invalid_request' })
    for (const result of [skipped, failed]) {
      expect(result).not.toHaveProperty('usage')
      expect(result).not.toHaveProperty('estimatedCostUsd')
      expect(result).not.toHaveProperty('answers')
    }
    expect(numericAdsetProfitabilityDecision(null)).toEqual({
      winner: 'INSUFFICIENT_EVIDENCE',
      readiness: 'OBSERVE'
    })
  })
})
