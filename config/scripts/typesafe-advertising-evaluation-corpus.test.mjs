import { describe, expect, it } from 'vitest'
import { snapshotDecisionRequest } from '../../src/shared/structured-decisions.ts'
import {
  advertisingDecisionKind,
  advertisingEvidence,
  advertisingTarget
} from '../../src/shared/typesafe-advertising.ts'
import {
  ADVERTISING_EVALUATION_CASES,
  AD_SIBLING_SIMULATION_POLICY
} from './typesafe-advertising-evaluation-corpus.mjs'

const tasks = ['ad_sibling_selection', 'ad_creative_alignment', 'ad_recommendation_audit']
const siblings = ADVERTISING_EVALUATION_CASES.filter(({ task }) => task === 'ad_sibling_selection')
const find = (id) => ADVERTISING_EVALUATION_CASES.find((item) => item.id === id)

describe('predeclared synthetic advertising evaluation corpus', () => {
  it('contains 48 unique cases with 4 development and 12 holdout cases per task', () => {
    expect(ADVERTISING_EVALUATION_CASES).toHaveLength(48)
    expect(new Set(ADVERTISING_EVALUATION_CASES.map(({ id }) => id)).size).toBe(48)
    expect(
      new Set(ADVERTISING_EVALUATION_CASES.map(({ state }) => JSON.stringify(state))).size
    ).toBe(48)
    for (const task of tasks) {
      const cases = ADVERTISING_EVALUATION_CASES.filter((item) => item.task === task)
      expect(cases).toHaveLength(16)
      expect(cases.filter(({ split }) => split === 'development')).toHaveLength(4)
      expect(cases.filter(({ split }) => split === 'holdout')).toHaveLength(12)
    }
    for (const item of ADVERTISING_EVALUATION_CASES) {
      expect(item.origin).toBe('authored_synthetic')
      expect(Object.isFrozen(item.expected)).toBe(true)
      expect(Object.values(item.expected).every(Object.isFrozen)).toBe(true)
      expect(item.id).toMatch(/^[a-z0-9-]+$/)
      expect(item.familyId).toMatch(/^[a-z0-9-]+$/)
      expect(item.rationale.length).toBeGreaterThan(30)
      const family = ADVERTISING_EVALUATION_CASES.filter(
        ({ familyId }) => familyId === item.familyId
      )
      expect(new Set(family.map(({ split }) => split)).size).toBe(1)
      expect(new Set(family.map(({ task }) => task)).size).toBe(1)
    }
  })

  it.each(ADVERTISING_EVALUATION_CASES)(
    'has bounded valid model inputs without labels: $id',
    (item) => {
      const request = {
        capability: `evaluation_${item.task}`,
        state: item.state,
        questions: item.questions,
        model: 'jev-1.13.0'
      }
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(16_384)
      expect(snapshotDecisionRequest(request)).toEqual(request)
      expect(Object.keys(request).sort()).toEqual(['capability', 'model', 'questions', 'state'])
      expect(Object.keys(item.expected).sort()).toEqual(Object.keys(item.questions).sort())
      for (const [id, question] of Object.entries(item.questions)) {
        const expected = item.expected[id]
        if (question.type === 'choice') {
          expect(Object.keys(question.criteria)).toContain(expected.value)
          expect(expected.tolerance).toBeUndefined()
        } else {
          expect(question.type).toBe('noul')
          expect([0, 1]).toContain(expected.value)
          expect(expected.tolerance).toBe(0.2)
        }
      }
    }
  )

  it('reuses production target, evidence and decision vocabularies without adding experimental fields', () => {
    for (const item of ADVERTISING_EVALUATION_CASES) {
      const observations =
        item.state.ads?.map(({ evidence }) => evidence) ??
        (item.state.evidence ? [item.state.evidence] : [])
      for (const evidence of observations) {
        expect(advertisingEvidence.safeParse(evidence).success).toBe(true)
        expect(advertisingTarget.safeParse(evidence.target).success).toBe(true)
        expect(evidence.target.objectType).toBe('ad')
        expect(evidence.target.accountId).toBe('act_900000')
        expect(evidence).not.toHaveProperty('attributionMature')
        expect(evidence).not.toHaveProperty('precomputedValidation')
      }
      if (item.task === 'ad_sibling_selection') {
        for (const expected of Object.values(item.expected)) {
          expect(advertisingDecisionKind.safeParse(expected.value).success).toBe(true)
        }
      }
    }
  })

  it('precomputes null-safe arithmetic and all numerical threshold flags in ordinary code', () => {
    const policy = AD_SIBLING_SIMULATION_POLICY
    expect(policy.scope).toContain('Fictional')
    for (const { state } of siblings) {
      expect(state.simulationPolicy).toEqual(policy)
      expect(state.ads.map(({ key }) => key)).toEqual(['ad_a', 'ad_b', 'ad_c'])
      for (const {
        evidence: { metrics },
        computed
      } of state.ads) {
        const cpa =
          metrics.spend === null || metrics.purchases === null || metrics.purchases === 0
            ? null
            : metrics.spend / metrics.purchases
        const roas =
          metrics.revenue === null || metrics.spend === null || metrics.spend === 0
            ? null
            : metrics.revenue / metrics.spend
        const complete = [metrics.spend, metrics.revenue, metrics.purchases].every(
          (value) => value !== null
        )
        const sufficient = complete && metrics.spend >= policy.minimumSpend
        expect(computed.costPerPurchase).toBe(cpa)
        expect(computed.revenueReturnOnSpend).toBe(roas)
        expect(metrics.roas).toBe(roas)
        expect(computed.metricsComplete).toBe(complete)
        expect(computed.spendSufficient).toBe(sufficient)
        expect(computed.keepThresholdsMet).toBe(
          sufficient &&
            metrics.purchases >= policy.minimumKeepPurchases &&
            cpa <= policy.maximumKeepCpa &&
            roas >= policy.minimumKeepRoas
        )
        expect(computed.pauseThresholdsMet).toBe(
          sufficient &&
            (metrics.purchases === 0 ||
              cpa > policy.maximumKeepCpa ||
              roas < policy.maximumPauseRoas)
        )
      }
    }
  })

  it('computes hierarchy, reporting-window, timestamp and sibling-count guard failures from fixture facts', () => {
    expect(find('siblings-holdout-07').state.group.precomputedValidation.hierarchyValid).toBe(false)
    expect(find('siblings-holdout-08').state.group.precomputedValidation.siblingCountMatches).toBe(
      false
    )
    expect(find('siblings-holdout-09').state.group.precomputedValidation.timestampsFresh).toBe(
      false
    )
    expect(find('siblings-holdout-10').state.group.precomputedValidation.windowsComparable).toBe(
      false
    )
    expect(
      find('siblings-dev-04').state.group.precomputedValidation.pauseWouldRemoveEveryActiveAd
    ).toBe(true)
    expect(
      find('siblings-dev-01').state.group.precomputedValidation.pauseWouldRemoveEveryActiveAd
    ).toBe(false)
    for (const id of [
      'siblings-holdout-03',
      'siblings-holdout-04',
      'siblings-holdout-07',
      'siblings-holdout-08',
      'siblings-holdout-09',
      'siblings-holdout-10',
      'siblings-holdout-11'
    ]) {
      expect(Object.values(find(id).expected).every(({ value }) => value === 'NO_ACTION')).toBe(
        true
      )
    }
  })

  it('retains multiple qualifying siblings, abstains on low delivery and rejects prompt injection', () => {
    expect(Object.values(find('siblings-dev-01').expected).map(({ value }) => value)).toEqual([
      'KEEP_RUNNING',
      'KEEP_RUNNING',
      'PAUSE'
    ])
    expect(
      Object.values(find('siblings-holdout-05').expected).every(
        ({ value }) => value === 'KEEP_RUNNING'
      )
    ).toBe(true)
    expect(find('siblings-dev-02').expected.ad_a.value).toBe('NO_ACTION')
    expect(find('siblings-holdout-12').state.ads[0].evidence.name).toContain('Ignore policy')
    expect(find('siblings-holdout-12').expected.ad_a.value).toBe('PAUSE')
  })

  it('defines review probability only for alignment and covers every decision class in both splits', () => {
    for (const split of ['development', 'holdout']) {
      for (const task of tasks) {
        const cases = ADVERTISING_EVALUATION_CASES.filter(
          (item) => item.task === task && item.split === split
        )
        const values = [
          ...new Set(
            cases.flatMap(({ expected }) =>
              Object.entries(expected)
                .filter(([key]) => key !== 'needs_review')
                .map(([, { value }]) => value)
            )
          )
        ].sort()
        expect(values).toEqual(
          task === 'ad_sibling_selection'
            ? ['KEEP_RUNNING', 'NO_ACTION', 'PAUSE']
            : task === 'ad_creative_alignment'
              ? ['aligned', 'mismatch', 'uncertain']
              : ['supported', 'uncertain', 'unsupported']
        )
      }
    }
    for (const item of ADVERTISING_EVALUATION_CASES.filter(
      ({ task }) => task === 'ad_creative_alignment'
    )) {
      expect(item.expected.needs_review.value).toBe(
        item.expected.decision.value === 'aligned' ? 0 : 1
      )
    }
  })
})
