import { describe, expect, it } from 'vitest'
import { snapshotDecisionRequest } from '../../src/shared/structured-decisions.ts'
import { PAIRWISE_EVALUATION_CASES } from './typesafe-advertising-pairwise-corpus.mjs'
import {
  evaluatePairwiseNumericReference,
  numericPairwiseSelection
} from './typesafe-advertising-pairwise-reference.mjs'

function fixture(scenarioId = 'clear-current', contextCondition = 'with_baselines') {
  const item = PAIRWISE_EVALUATION_CASES.find(
    (candidate) =>
      candidate.experiment.scenarioId === scenarioId &&
      candidate.experiment.contextCondition === contextCondition &&
      candidate.experiment.presentationOrder === 'AB'
  )
  return structuredClone(item.state)
}

const request = (state = fixture()) => ({
  capability: 'evaluation_ad_pairwise_selection',
  state,
  questions: structuredClone(PAIRWISE_EVALUATION_CASES[0].questions)
})
const insufficient = (state) => expect(numericPairwiseSelection(state)).toBe('INSUFFICIENT_DATA')

describe('evaluation-only pairwise numerical reference', () => {
  it('returns normalized zero-cost answers without changing immutable evidence', () => {
    const input = snapshotDecisionRequest(request())
    const before = JSON.stringify(input)
    const result = evaluatePairwiseNumericReference(input)
    expect(result).toMatchObject({
      status: 'success',
      answers: { selection: { value: 'KEEP_A' } },
      usage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0
    })
    expect(Number.isFinite(result.elapsedMs)).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Object.isFrozen(input.state.ads[0].current.metrics)).toBe(true)
    expect(JSON.stringify(input)).toBe(before)
  })

  it('uses raw metrics rather than forged computed facts or evaluator labels', () => {
    const input = request()
    for (const key of ['expected', 'rationale', 'familyId', 'split', 'experiment']) {
      Object.defineProperty(input, key, {
        get() {
          throw new Error('private_label_accessed')
        }
      })
    }
    input.state.group.precomputed = { hierarchyMatches: false, currentWindowsComparable: false }
    for (const ad of input.state.ads) {
      ad.current.computed = { metricsComplete: false, zeroPurchases: true, selection: 'KEEP_B' }
    }
    input.state.historicalBaseline.computed = { selection: 'KEEP_NEITHER' }
    expect(evaluatePairwiseNumericReference(input).answers).toEqual({
      selection: { value: 'KEEP_A' }
    })
    input.state.ads[0].current.metrics = { spend: 150, purchases: 0, revenue: 0 }
    expect(numericPairwiseSelection(input.state)).toBe('KEEP_NEITHER')
  })

  it('skips unrelated capabilities without reading their state', () => {
    const input = { capability: 'evaluation_ad_creative_alignment' }
    Object.defineProperty(input, 'state', {
      get() {
        throw new Error('unrelated_state_accessed')
      }
    })
    expect(evaluatePairwiseNumericReference(input)).toEqual({
      status: 'skipped',
      elapsedMs: 0,
      errorCode: 'not_applicable'
    })
  })

  it.each([undefined, null, [], {}, { ads: [] }, { ads: [null, null] }])(
    'sanitizes malformed pair state: %j',
    (state) => {
      expect(() => numericPairwiseSelection(state)).toThrow('invalid_synthetic_ad_pair')
      expect(evaluatePairwiseNumericReference({ ...request(), state })).toMatchObject({
        status: 'error',
        errorCode: 'invalid_request'
      })
    }
  )

  it.each(['duplicate', 'unknown'])('rejects %s displayed slot identities', (kind) => {
    const state = fixture()
    state.ads[1].slot = kind === 'duplicate' ? 'A' : 'C'
    expect(() => numericPairwiseSelection(state)).toThrow('invalid_synthetic_ad_pair')
  })

  it.each([
    undefined,
    null,
    {},
    { another: {} },
    { selection: {} },
    { selection: { type: 'noul', criteria: {} } }
  ])('rejects invalid question shape: %j', (questions) => {
    expect(evaluatePairwiseNumericReference({ ...request(), questions })).toMatchObject({
      status: 'error',
      errorCode: 'invalid_request'
    })
  })

  it.each(['missing', 'extra', 'extra_question'])('rejects %s selection contract', (kind) => {
    const input = request()
    if (kind === 'missing') {
      delete input.questions.selection.criteria.INSUFFICIENT_DATA
    }
    if (kind === 'extra') {
      input.questions.selection.criteria.EXECUTE_PAUSE = 'not an evaluation'
    }
    if (kind === 'extra_question') {
      input.questions.extra = input.questions.selection
    }
    expect(evaluatePairwiseNumericReference(input)).toMatchObject({
      status: 'error',
      errorCode: 'invalid_request'
    })
  })

  it.each([undefined, null, {}, 'historical instruction', { dateStop: '2099-12-31' }])(
    'does not override sufficient current evidence with malformed history: %j',
    (history) => {
      const state = fixture()
      state.historicalBaseline = history
      expect(numericPairwiseSelection(state)).toBe('KEEP_A')
    }
  )

  it('uses valid baseline only for complete mature low-spend current observations', () => {
    const state = fixture('history-fills-low-delivery')
    expect(numericPairwiseSelection(state)).toBe('KEEP_A')
    delete state.historicalBaseline
    insufficient(state)
  })

  it.each(['spend', 'purchases', 'revenue'])(
    'never rescues missing current %s with history',
    (key) => {
      const state = fixture('history-fills-low-delivery')
      delete state.ads[0].current.metrics[key]
      insufficient(state)
    }
  )

  it.each([null, -1, Infinity, Number.NaN, '0'])(
    'rejects malformed metrics instead of treating %j as zero',
    (value) => {
      const state = fixture('history-fills-low-delivery')
      state.ads[0].current.metrics.purchases = value
      insufficient(state)
    }
  )

  it('distinguishes complete zero spend from missing spend', () => {
    const state = fixture('history-fills-low-delivery')
    state.ads[0].current.metrics = { spend: 0, purchases: 0, revenue: 0 }
    expect(numericPairwiseSelection(state)).toBe('KEEP_A')
    state.ads[0].current.metrics.spend = null
    insufficient(state)
  })

  it.each([
    ['complete', false],
    ['parentStatus', 'PAUSED'],
    ['trackingIntegrity', 'broken'],
    ['expectedSiblingCount', 3],
    ['comparisonScope', 'selected_subset'],
    ['objective', 'clicks'],
    ['observedAt', 'invalid'],
    ['dateStart', '2026-09-30']
  ])('abstains when group guard %s is invalid', (key, value) => {
    const state = fixture()
    state.group[key] = value
    insufficient(state)
  })

  it.each(['company', 'accountId', 'campaignId', 'adsetId', 'currency', 'timezone', 'attribution'])(
    'requires nonempty group %s',
    (key) => {
      const state = fixture()
      delete state.group[key]
      insufficient(state)
    }
  )

  it.each([
    ['adsetId', 'other_adset'],
    ['status', 'PAUSED'],
    ['adId', '900101'],
    ['ageDays', -1]
  ])('rejects invalid ad identity or eligibility %s', (key, value) => {
    const state = fixture()
    state.ads[1][key] = value
    insufficient(state)
  })

  it.each([
    ['dateStart', '2026-09-14'],
    ['dateStop', '2026-09-16'],
    ['timezone', 'America/New_York'],
    ['attribution', '1d_click'],
    ['trackingIntegrity', 'broken'],
    ['fetchedAt', '2026-09-21T10:00:00+00:00'],
    ['fetchedAt', '2026-09-21T12:00:01+00:00'],
    ['observedThrough', '2026-09-20T23:59:59+00:00'],
    ['observedThrough', 'invalid']
  ])('rejects invalid current snapshot %s=%s', (key, value) => {
    const state = fixture('history-fills-low-delivery')
    state.ads[0].current[key] = value
    insufficient(state)
  })

  it('binds maturity to the declared end of the current window, not a forged old timestamp', () => {
    const state = fixture()
    state.group.dateStop = '2026-09-23'
    for (const ad of state.ads) {
      ad.current.dateStop = state.group.dateStop
    }
    insufficient(state)
  })

  it('requires a completed declared day, not an early-day maturity shortcut', () => {
    const state = fixture()
    state.ads[0].current.observedThrough = '2026-09-17T00:00:00+00:00'
    insufficient(state)
  })

  it.each(['adsetId', 'currency', 'objective', 'timezone', 'attribution'])(
    'rejects a mismatched historical %s context',
    (key) => {
      const state = fixture('history-fills-low-delivery')
      state.historicalBaseline.context[key] = 'mismatched_context'
      insufficient(state)
    }
  )

  it.each(['missing', 'duplicate', 'unrelated', 'sparse', 'missing_metric', 'young'])(
    'rejects %s historical evidence',
    (kind) => {
      const state = fixture('history-fills-low-delivery')
      const history = state.historicalBaseline
      if (kind === 'missing') {
        history.ads.pop()
      }
      if (kind === 'duplicate') {
        history.ads[1].adId = history.ads[0].adId
      }
      if (kind === 'unrelated') {
        history.ads[1].adId = '900999'
      }
      if (kind === 'sparse') {
        history.ads[0].snapshot.metrics.spend = 20
      }
      if (kind === 'missing_metric') {
        history.ads[0].snapshot.metrics.revenue = null
      }
      if (kind === 'young') {
        state.ads[0].ageDays = 13
      }
      insufficient(state)
    }
  )

  it.each(['aggregate', 'ad'])(
    'validates %s historical snapshot freshness and window completion',
    (kind) => {
      for (const [key, value] of [
        ['fetchedAt', '2026-09-21T10:00:00+00:00'],
        ['fetchedAt', '2026-09-21T12:00:01+00:00'],
        ['observedThrough', '2026-09-01T23:59:59+00:00'],
        ['trackingIntegrity', 'broken'],
        ['dateStop', '2026-09-13'],
        ['attribution', '1d_click']
      ]) {
        const state = fixture('history-fills-low-delivery')
        const snapshot =
          kind === 'aggregate'
            ? state.historicalBaseline.adset
            : state.historicalBaseline.ads[0].snapshot
        snapshot[key] = value
        insufficient(state)
      }
    }
  )

  it('rejects future historical windows even if their observation timestamps are forged old', () => {
    const state = fixture('history-fills-low-delivery')
    const history = state.historicalBaseline
    history.dateStart = '2026-09-22'
    history.dateStop = '2026-09-23'
    for (const snapshot of [history.adset, ...history.ads.map((ad) => ad.snapshot)]) {
      snapshot.dateStart = history.dateStart
      snapshot.dateStop = history.dateStop
    }
    insufficient(state)
  })

  it('does not let history replace complete but inconclusive current economics', () => {
    const state = fixture('history-fills-low-delivery')
    state.ads[0].current.metrics = { spend: 100, purchases: 2, revenue: 150 }
    insufficient(state)
  })

  it.each(Object.keys(fixture().simulationPolicy))('rejects tampered policy field %s', (key) => {
    const state = fixture()
    state.simulationPolicy[key] = typeof state.simulationPolicy[key] === 'number' ? 0 : 'tampered'
    insufficient(state)
  })

  it('rejects an ad old enough for the minimum but created after its alleged history began', () => {
    const state = fixture('history-fills-low-delivery')
    state.ads[0].ageDays = 14
    insufficient(state)
  })

  it('accepts exact freshness and full-history age boundaries without requiring a strict excess', () => {
    const state = fixture('history-fills-low-delivery')
    for (const ad of state.ads) {
      ad.ageDays = 20.5
      ad.current.fetchedAt = '2026-09-21T11:55:00+00:00'
    }
    expect(numericPairwiseSelection(state)).toBe('KEEP_A')
  })
})
