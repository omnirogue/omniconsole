import { describe, expect, it } from 'vitest'
import { snapshotDecisionRequest } from '../../src/shared/structured-decisions.ts'
import {
  PAIRWISE_EVALUATION_CASES,
  PAIRWISE_POLICY,
  evaluatePairwiseNumericReference
} from './typesafe-advertising-pairwise-corpus.mjs'

const contexts = ['current_only', 'with_baselines']
const orders = ['AB', 'BA']
const labels = ['KEEP_A', 'KEEP_B', 'KEEP_BOTH', 'KEEP_NEITHER', 'INSUFFICIENT_DATA']
const requestFor = (item) => ({
  capability: 'evaluation_ad_pairwise_selection',
  model: 'jev-1.13.0',
  state: item.state,
  questions: item.questions
})
const casesFor = (scenarioId, contextCondition) =>
  PAIRWISE_EVALUATION_CASES.filter(
    (item) =>
      item.experiment.scenarioId === scenarioId &&
      (!contextCondition || item.experiment.contextCondition === contextCondition)
  )

function selectedIds(item) {
  const value = item.expected.selection.value
  const ids = item.experiment.adIdsBySlot
  if (value === 'KEEP_A') {
    return [ids.A]
  }
  if (value === 'KEEP_B') {
    return [ids.B]
  }
  if (value === 'KEEP_BOTH') {
    return [ids.A, ids.B].sort()
  }
  return value
}

describe('matched synthetic advertising context and pairwise-order corpus', () => {
  it('contains 48 bounded authored cases in 12 split-disjoint matched families', () => {
    expect(PAIRWISE_EVALUATION_CASES).toHaveLength(48)
    expect(new Set(PAIRWISE_EVALUATION_CASES.map((item) => item.id)).size).toBe(48)
    expect(new Set(PAIRWISE_EVALUATION_CASES.map((item) => item.familyId)).size).toBe(12)
    expect(PAIRWISE_EVALUATION_CASES.filter((item) => item.split === 'development')).toHaveLength(
      12
    )
    expect(PAIRWISE_EVALUATION_CASES.filter((item) => item.split === 'holdout')).toHaveLength(36)
    for (const familyId of new Set(PAIRWISE_EVALUATION_CASES.map((item) => item.familyId))) {
      const family = PAIRWISE_EVALUATION_CASES.filter((item) => item.familyId === familyId)
      expect(family).toHaveLength(4)
      expect(new Set(family.map((item) => item.split)).size).toBe(1)
      expect(
        family
          .map((item) => `${item.experiment.contextCondition}/${item.experiment.presentationOrder}`)
          .sort()
      ).toEqual(contexts.flatMap((context) => orders.map((order) => `${context}/${order}`)).sort())
    }
    for (const item of PAIRWISE_EVALUATION_CASES) {
      expect(item.origin).toBe('authored_synthetic')
      expect(item.task).toBe('ad_pairwise_selection')
      expect(item.id).toMatch(/^[a-z0-9-]+$/)
      expect(item.state.simulationPolicy).toEqual(PAIRWISE_POLICY)
      expect(item.rationale.length).toBeGreaterThan(40)
      expect(Object.keys(item.questions)).toEqual(['selection'])
      expect(item.questions.selection.type).toBe('choice')
      expect(Object.keys(item.questions.selection.criteria)).toEqual(labels)
      expect(labels).toContain(item.expected.selection.value)
    }
  })

  it.each(PAIRWISE_EVALUATION_CASES)(
    'validates a label-free request and bounded wire envelopes for $id',
    (item) => {
      const request = requestFor(item)
      const snapshot = snapshotDecisionRequest(request)
      expect(snapshot).toEqual(request)
      expect(Object.isFrozen(snapshot.state)).toBe(true)
      expect(Object.keys(snapshot).sort()).toEqual(['capability', 'model', 'questions', 'state'])
      const modelText = JSON.stringify(snapshot)
      for (const privateValue of [
        item.id,
        item.familyId,
        item.rationale,
        item.experiment.scenarioId
      ]) {
        expect(modelText).not.toContain(privateValue)
      }
      for (const privateKey of [
        'expected',
        'rationale',
        'familyId',
        'split',
        'experiment',
        'contextCondition',
        'presentationOrder'
      ]) {
        expect(modelText).not.toContain(`"${privateKey}":`)
      }
      expect(Buffer.byteLength(modelText)).toBeLessThan(16_384 - 2000)
      const typesafeEnvelope = {
        model: request.model,
        state: request.state,
        questions: request.questions
      }
      const geminiEnvelope = {
        contents: [
          {
            parts: [
              {
                text: `Evaluation formatting instructions.\n${JSON.stringify({ state: request.state, questions: request.questions })}`
              }
            ]
          }
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            properties: { selection: { type: 'string', enum: labels } },
            required: ['selection'],
            additionalProperties: false
          },
          thinkingConfig: { thinkingLevel: 'low' },
          maxOutputTokens: 1024
        }
      }
      expect(Buffer.byteLength(JSON.stringify(typesafeEnvelope))).toBeLessThan(16_384)
      expect(Buffer.byteLength(JSON.stringify(geminiEnvelope))).toBeLessThan(16_384 - 1000)
    }
  )

  it('keeps current data identical and completely removes baseline facts from the current-only condition', () => {
    for (const scenarioId of new Set(
      PAIRWISE_EVALUATION_CASES.map((item) => item.experiment.scenarioId)
    )) {
      for (const order of orders) {
        const family = casesFor(scenarioId).filter(
          (item) => item.experiment.presentationOrder === order
        )
        const current = family.find((item) => item.experiment.contextCondition === 'current_only')
        const enriched = family.find(
          (item) => item.experiment.contextCondition === 'with_baselines'
        )
        expect(current.state).not.toHaveProperty('historicalBaseline')
        expect(enriched.state).toHaveProperty('historicalBaseline')
        const { historicalBaseline, ...withoutHistory } = enriched.state
        expect(withoutHistory).toEqual(current.state)
        expect(historicalBaseline.context.adsetId).toBe(current.state.group.adsetId)
        expect(current.questions).toEqual(enriched.questions)
        expect(Object.keys(current.state)).toEqual(['simulationPolicy', 'group', 'ads'])
      }
    }
  })

  it('counterbalances which context and presentation order are encountered first', () => {
    const firstByFamily = [...new Set(PAIRWISE_EVALUATION_CASES.map((item) => item.familyId))].map(
      (familyId) => PAIRWISE_EVALUATION_CASES.find((item) => item.familyId === familyId)
    )
    for (const context of contexts) {
      expect(
        firstByFamily.filter((item) => item.experiment.contextCondition === context)
      ).toHaveLength(6)
    }
    for (const order of orders) {
      expect(
        firstByFamily.filter((item) => item.experiment.presentationOrder === order)
      ).toHaveLength(6)
    }
    for (const context of contexts) {
      for (const order of orders) {
        expect(
          firstByFamily.filter(
            (item) =>
              item.experiment.contextCondition === context &&
              item.experiment.presentationOrder === order
          )
        ).toHaveLength(3)
      }
    }
  })

  it('truly reverses physical ad IDs, metrics and historical entries while remapping selection labels', () => {
    for (const scenarioId of new Set(
      PAIRWISE_EVALUATION_CASES.map((item) => item.experiment.scenarioId)
    )) {
      for (const context of contexts) {
        const pair = casesFor(scenarioId, context)
        const ab = pair.find((item) => item.experiment.presentationOrder === 'AB')
        const ba = pair.find((item) => item.experiment.presentationOrder === 'BA')
        expect(ab.experiment.presentationOrder).toBe('AB')
        expect(ba.experiment.presentationOrder).toBe('BA')
        expect(ab.experiment.adIdsBySlot).toEqual({ A: '900101', B: '900102' })
        expect(ba.experiment.adIdsBySlot).toEqual({ A: '900102', B: '900101' })
        expect(ab.state.ads.map((ad) => ad.slot)).toEqual(['A', 'B'])
        expect(ba.state.ads.map((ad) => ad.slot)).toEqual(['A', 'B'])
        expect(ab.state.ads.map(({ slot: _slot, ...ad }) => ad)).toEqual(
          ba.state.ads.map(({ slot: _slot, ...ad }) => ad).toReversed()
        )
        expect(selectedIds(ab)).toEqual(selectedIds(ba))
        if (context === 'with_baselines') {
          expect(ab.state.historicalBaseline.ads).toEqual(
            ba.state.historicalBaseline.ads.toReversed()
          )
          expect(ab.state.historicalBaseline.adset).toEqual(ba.state.historicalBaseline.adset)
        }
      }
    }
  })

  it('changes labels only when additional visible history legitimately supports decisiveness', () => {
    const changed = []
    for (const scenarioId of new Set(
      PAIRWISE_EVALUATION_CASES.map((item) => item.experiment.scenarioId)
    )) {
      const current = casesFor(scenarioId, 'current_only')[0]
      const enriched = casesFor(scenarioId, 'with_baselines')[0]
      if (current.expected.selection.value !== enriched.expected.selection.value) {
        expect(current.expected.selection.value).toBe('INSUFFICIENT_DATA')
        expect(enriched.expected.selection.value).not.toBe('INSUFFICIENT_DATA')
        changed.push(scenarioId)
      }
    }
    expect(changed.sort()).toEqual(['history-fills-low-delivery', 'history-supports-both'])
  })

  it('does not force a winner, confuse CTR with purchases, or trust invalid added context', () => {
    expect(
      casesFor('retain-two-good-ads').every((item) => item.expected.selection.value === 'KEEP_BOTH')
    ).toBe(true)
    expect(
      casesFor('both-mature-and-poor').every(
        (item) => item.expected.selection.value === 'KEEP_NEITHER'
      )
    ).toBe(true)
    expect(selectedIds(casesFor('clicks-are-not-purchases', 'current_only')[0])).toEqual(['900102'])
    for (const scenarioId of [
      'new-under-delivered-ads',
      'conversions-still-arriving',
      'tracking-break',
      'future-history-leakage',
      'stale-history'
    ]) {
      expect(
        casesFor(scenarioId).every((item) => item.expected.selection.value === 'INSUFFICIENT_DATA')
      ).toBe(true)
    }
    expect(
      casesFor('recent-recovery-authoritative').every(
        (item) => item.expected.selection.value === 'KEEP_BOTH'
      )
    ).toBe(true)
  })

  it.each(PAIRWISE_EVALUATION_CASES)(
    'has separately authored labels consistent with the raw numeric reference for $id',
    (item) => {
      const result = evaluatePairwiseNumericReference(requestFor(item))
      expect(result.status).toBe('success')
      expect(result.answers).toEqual(item.expected)
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
      expect(result.estimatedCostUsd).toBe(0)
    }
  )
})
