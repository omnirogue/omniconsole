import { describe, expect, it } from 'vitest'
import { summarizePairwiseExperiment } from './typesafe-advertising-pairwise-analysis.mjs'

const conditions = ['current_only', 'with_baselines']

function family(scenarioId, split = 'development', labels = ['INSUFFICIENT_DATA', 'KEEP_A']) {
  return conditions.flatMap((contextCondition, index) =>
    ['AB', 'BA'].map((presentationOrder) => {
      const label = labels[index]
      const value =
        presentationOrder === 'BA' && ['KEEP_A', 'KEEP_B'].includes(label)
          ? label === 'KEEP_A'
            ? 'KEEP_B'
            : 'KEEP_A'
          : label
      return {
        id: `${scenarioId}-${contextCondition}-${presentationOrder}`,
        familyId: `family-${scenarioId}`,
        split,
        task: 'ad_pairwise_selection',
        experiment: {
          scenarioId,
          contextCondition,
          presentationOrder,
          adIdsBySlot:
            presentationOrder === 'AB'
              ? { A: `${scenarioId}-z`, B: `${scenarioId}-a` }
              : { A: `${scenarioId}-a`, B: `${scenarioId}-z` }
        },
        expected: { selection: { value } }
      }
    })
  )
}

function observation(item, value = item.expected.selection.value, arm = 'typesafe') {
  return { caseId: item.id, arm, status: 'success', answers: { selection: { value } } }
}

const group = (summary, split = 'all', arm = 'typesafe') =>
  summary.groups.find((entry) => entry.split === split && entry.arm === arm)

describe('pairwise advertising experiment analysis', () => {
  it('maps swapped KEEP_A and KEEP_B answers to the same stable native ad identity', () => {
    const cases = family('winner', 'development', ['KEEP_A', 'KEEP_B'])
    const observations = cases.map((item) => observation(item))
    const before = structuredClone({ cases, observations })
    const summary = summarizePairwiseExperiment(cases, observations)
    expect(group(summary).order).toEqual({
      plannedPairs: 2,
      completePairs: 2,
      stableAdIdAgreement: 2,
      disagreements: [],
      incompletePairs: 0
    })
    for (const condition of conditions) {
      expect(group(summary).context[condition]).toEqual({
        cases: 2,
        successful: 2,
        correct: 2,
        supportedDecisions: 2,
        expectedDecisive: 2,
        actualDecisive: 2,
        unsafeDecisionsFromInsufficientEvidence: 0
      })
    }
    expect({ cases, observations }).toEqual(before)
  })

  it('detects slot preference even when the literal answer is identical in both orders', () => {
    const cases = family('slot-bias', 'development', ['KEEP_A', 'KEEP_A'])
    const summary = summarizePairwiseExperiment(
      cases,
      cases.map((item) => observation(item, 'KEEP_A'))
    )
    expect(group(summary).order).toEqual({
      plannedPairs: 2,
      completePairs: 2,
      stableAdIdAgreement: 0,
      disagreements: ['slot-bias/current_only', 'slot-bias/with_baselines'],
      incompletePairs: 0
    })
    expect(group(summary).context.current_only.correct).toBe(1)
    expect(group(summary).context.with_baselines.correct).toBe(1)
  })

  it('normalizes KEEP_BOTH as the same sorted ID set and keeps KEEP_NEITHER stable', () => {
    const cases = family('sets', 'development', ['KEEP_BOTH', 'KEEP_NEITHER'])
    const summary = summarizePairwiseExperiment(
      cases,
      cases.map((item) => observation(item))
    )
    expect(group(summary).order.stableAdIdAgreement).toBe(2)
    expect(group(summary).order.disagreements).toEqual([])
    expect(group(summary).context.current_only.supportedDecisions).toBe(2)
    expect(group(summary).context.with_baselines.supportedDecisions).toBe(2)
  })

  it.each([
    ['KEEP_BOTH', 'KEEP_NEITHER'],
    ['KEEP_BOTH', 'INSUFFICIENT_DATA'],
    ['KEEP_NEITHER', 'INSUFFICIENT_DATA']
  ])('does not conflate %s with %s in order agreement', (left, right) => {
    const cases = family('distinct', 'development', [left, left]).slice(0, 2)
    const summary = summarizePairwiseExperiment(cases, [
      observation(cases[0], left),
      observation(cases[1], right)
    ])
    expect(group(summary).order).toMatchObject({
      plannedPairs: 1,
      completePairs: 1,
      stableAdIdAgreement: 0,
      disagreements: ['distinct/current_only'],
      incompletePairs: 0
    })
  })

  it('excludes missing and failed members from complete-pair agreement denominators', () => {
    const cases = [...family('dev'), ...family('hold', 'holdout')]
    const observations = cases
      .filter((item) => item.id !== 'dev-current_only-AB')
      .map((item) =>
        item.id === 'dev-with_baselines-BA'
          ? { caseId: item.id, arm: 'typesafe', status: 'error', errorCode: 'timeout' }
          : observation(item)
      )
    const summary = summarizePairwiseExperiment(cases, observations)
    expect(group(summary).order).toEqual({
      plannedPairs: 4,
      completePairs: 2,
      stableAdIdAgreement: 2,
      disagreements: [],
      incompletePairs: 2
    })
    for (const condition of conditions) {
      expect(group(summary).context[condition]).toMatchObject({
        cases: 4,
        successful: 3,
        correct: 3
      })
    }
    expect(group(summary, 'development').order.completePairs).toBe(0)
    expect(group(summary, 'holdout').order.completePairs).toBe(2)
  })

  it.each([
    { status: 'skipped', errorCode: 'request_budget_exhausted' },
    { status: 'success', answers: {} },
    { status: 'success', answers: { selection: { value: 'UNKNOWN_CHOICE' } } }
  ])('does not count an unusable answer as stable agreement: %j', (replacement) => {
    const cases = family('incomplete').slice(0, 2)
    const summary = summarizePairwiseExperiment(cases, [
      observation(cases[0]),
      { caseId: cases[1].id, arm: 'typesafe', ...replacement }
    ])
    expect(group(summary).order).toEqual({
      plannedPairs: 1,
      completePairs: 0,
      stableAdIdAgreement: 0,
      disagreements: [],
      incompletePairs: 1
    })
  })

  it('counts independent families separately from four related presentations and splits', () => {
    const cases = [...family('dev'), ...family('hold', 'holdout')]
    const summary = summarizePairwiseExperiment(
      cases,
      cases.map((item) => observation(item))
    )
    expect(group(summary).scenarioFamilies).toBe(2)
    expect(group(summary, 'development').scenarioFamilies).toBe(1)
    expect(group(summary, 'holdout').scenarioFamilies).toBe(1)
    expect(group(summary).context.current_only.cases).toBe(4)
    expect(group(summary).context.with_baselines.cases).toBe(4)
    expect(summary.unit).toContain('four related presentations are not four independent examples')
    expect(summary.interpretation).toContain('not causal profit uplift')
    expect(group(summary, 'all', 'gemini').order).toMatchObject({
      completePairs: 0,
      incompletePairs: 4
    })
  })

  it('separates supported decisiveness, false certainty and ordinary incorrect decisions', () => {
    const cases = family('context')
    const observations = cases.map((item, index) =>
      observation(item, ['KEEP_A', 'INSUFFICIENT_DATA', 'KEEP_A', 'KEEP_A'][index])
    )
    const summary = summarizePairwiseExperiment(cases, observations)
    expect(group(summary).context.current_only).toEqual({
      cases: 2,
      successful: 2,
      correct: 1,
      supportedDecisions: 0,
      expectedDecisive: 0,
      actualDecisive: 1,
      unsafeDecisionsFromInsufficientEvidence: 1
    })
    expect(group(summary).context.with_baselines).toEqual({
      cases: 2,
      successful: 2,
      correct: 1,
      supportedDecisions: 1,
      expectedDecisive: 2,
      actualDecisive: 2,
      unsafeDecisionsFromInsufficientEvidence: 0
    })
  })

  it('ignores unrelated tasks, unknown case observations and unregistered arms', () => {
    const cases = family('in-scope')
    const observations = cases.map((item) => observation(item))
    const clean = summarizePairwiseExperiment(cases, observations)
    const extraCase = { id: 'unrelated', task: 'ad_creative_alignment', split: 'holdout' }
    const noisy = summarizePairwiseExperiment(
      [...cases, extraCase],
      [
        ...observations,
        { caseId: 'unrelated', arm: 'typesafe', status: 'success' },
        { caseId: 'not-in-corpus', arm: 'typesafe', status: 'success' },
        { ...observation(cases[0], 'KEEP_NEITHER'), arm: 'unregistered' }
      ]
    )
    expect(noisy).toEqual(clean)
    expect(summarizePairwiseExperiment([extraCase], observations).groups).toEqual([])
  })
})
