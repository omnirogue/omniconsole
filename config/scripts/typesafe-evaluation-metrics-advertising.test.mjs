import { describe, expect, it } from 'vitest'

import { summarizeEvaluation } from './typesafe-evaluation-metrics.mjs'

const pairwiseChoices = ['KEEP_A', 'KEEP_B', 'KEEP_BOTH', 'KEEP_NEITHER', 'INSUFFICIENT_DATA']
const pairwiseSafetyCases = [
  ['KEEP_A', [0, 1, 0, 1, 0]],
  ['KEEP_B', [1, 0, 0, 1, 0]],
  ['KEEP_BOTH', [1, 1, 0, 1, 0]],
  ['KEEP_NEITHER', [0, 0, 0, 0, 0]],
  ['INSUFFICIENT_DATA', [1, 1, 1, 1, 0]]
].flatMap(([expected, flags]) =>
  flags.map((critical, index) => [expected, pairwiseChoices[index], critical])
)

function answers(values, confidence) {
  return Object.fromEntries(
    Object.entries(values).map(([id, value]) => [id, { value, confidence }])
  )
}

function fixture(id, task, expected) {
  return {
    id,
    familyId: `family-${id}`,
    split: 'holdout',
    origin: 'authored_synthetic',
    task,
    state: { note: 'Synthetic advertising regression input.' },
    questions: Object.fromEntries(
      Object.keys(expected).map((key) => [
        key,
        {
          type: 'choice',
          instructions: 'Evaluate the supplied synthetic advertising evidence.'
        }
      ])
    ),
    expected: answers(expected),
    rationale: 'Authored synthetic labels, not production evidence.'
  }
}

function observation(caseId, values, overrides = {}) {
  return {
    caseId,
    arm: 'typesafe',
    status: 'success',
    elapsedMs: 10,
    answers: answers(values),
    ...overrides
  }
}

function summarize(cases, observations) {
  return summarizeEvaluation(cases, observations, { baselineArm: 'numeric_reference' })
}

function measuredGroup(report) {
  return report.groups.find(({ arm }) => arm === 'typesafe')
}

describe('advertising selection evaluation metrics', () => {
  it.each(pairwiseSafetyCases)(
    'scores pairwise expected %s and predicted %s with %i critical mistakes',
    (expected, predicted, critical) => {
      const input = fixture('pair', 'ad_pairwise_selection', { selection: expected })
      const actual = measuredGroup(
        summarize([input], [observation('pair', { selection: predicted })])
      )
      const question = actual.perQuestion[0]
      expect(question).toMatchObject({
        correct: Number(expected === predicted),
        total: 1,
        criticalFalsePositives: critical,
        criticalFalsePositiveOpportunities: Number(expected !== 'KEEP_NEITHER')
      })
      expect(actual.quality.cases.accuracy).toBe(Number(expected === predicted))
      expect(question).not.toHaveProperty('winnerRetention')
    }
  )

  it('keeps pairwise abstention misses separate from missing, failed and unavailable answers', () => {
    const rows = [
      ['correct', 'INSUFFICIENT_DATA', 'INSUFFICIENT_DATA'],
      ['missed', 'INSUFFICIENT_DATA', 'KEEP_A'],
      ['partial', 'INSUFFICIENT_DATA', undefined],
      ['unnecessary', 'KEEP_A', 'INSUFFICIENT_DATA'],
      ['neither', 'KEEP_NEITHER', 'KEEP_NEITHER'],
      ['failed', 'INSUFFICIENT_DATA', 'KEEP_NEITHER'],
      ['absent', 'INSUFFICIENT_DATA', undefined]
    ]
    const cases = rows.map(([id, selection]) => fixture(id, 'ad_pairwise_selection', { selection }))
    const observations = rows
      .filter(([id]) => id !== 'absent')
      .map(([id, , selection]) =>
        observation(id, selection === undefined ? {} : { selection }, {
          status: id === 'failed' ? 'error' : 'success'
        })
      )
    const actual = measuredGroup(summarize(cases, observations))
    expect(actual.quality).toMatchObject({
      cases: { correct: 2, total: 7, accuracy: 2 / 7 },
      questions: { correct: 2, total: 7, accuracy: 2 / 7 }
    })
    expect(actual.perQuestion[0]).toMatchObject({
      answered: 4,
      missing: 3,
      criticalFalsePositives: 1,
      criticalFalsePositiveOpportunities: 6,
      abstention: {
        label: 'INSUFFICIENT_DATA',
        expected: 5,
        actual: 2,
        correct: 1,
        missed: 1,
        unnecessary: 1,
        missing: 3
      }
    })
  })

  it('scores ad-set winners and readiness jointly while isolating unsafe review readiness', () => {
    const observe = 'OBSERVE'
    const ready = 'READY_FOR_HUMAN_REVIEW'
    const insufficient = 'INSUFFICIENT_EVIDENCE'
    const rows = [
      ['ready', 'ADSET_A', ready, 'ADSET_A', ready],
      ['unsafe', 'ADSET_B', observe, 'ADSET_B', ready],
      ['withheld', 'ADSET_C', ready, insufficient, observe],
      ['uncertain', insufficient, observe, insufficient, observe],
      ['missed', insufficient, observe, 'TIE', ready],
      ['partial', 'TIE', observe, 'TIE', undefined],
      ['failed', insufficient, observe, insufficient, observe],
      ['absent', insufficient, observe, undefined, undefined]
    ]
    const cases = rows.map(([id, winner, readiness]) =>
      fixture(id, 'adset_profitability_selection', { winner, readiness })
    )
    const observations = rows
      .filter(([id]) => id !== 'absent')
      .map(([id, , , winner, readiness]) =>
        observation(
          id,
          { winner, ...(readiness === undefined ? {} : { readiness }) },
          {
            status: id === 'failed' ? 'error' : 'success'
          }
        )
      )
    const actual = measuredGroup(summarize(cases, observations))
    expect(actual).toMatchObject({ attempted: 7, success: 6, errors: 1, missing: 1 })
    expect(actual.quality).toMatchObject({
      cases: { correct: 2, total: 8, accuracy: 0.25 },
      questions: { correct: 6, total: 16, accuracy: 0.375 }
    })
    const winner = actual.perQuestion.find(({ id }) => id === 'winner')
    const readiness = actual.perQuestion.find(({ id }) => id === 'readiness')
    expect(winner).toMatchObject({
      correct: 4,
      total: 8,
      criticalFalsePositives: null,
      criticalFalsePositiveOpportunities: null,
      abstention: {
        label: insufficient,
        expected: 4,
        actual: 2,
        correct: 1,
        missed: 1,
        unnecessary: 1,
        missing: 2
      }
    })
    expect(readiness).toMatchObject({
      correct: 2,
      total: 8,
      criticalFalsePositives: 2,
      criticalFalsePositiveOpportunities: 6,
      abstention: {
        label: observe,
        expected: 6,
        actual: 2,
        correct: 1,
        missed: 2,
        unnecessary: 1,
        missing: 3
      }
    })
    expect(winner).not.toHaveProperty('winnerRetention')
    expect(readiness).not.toHaveProperty('winnerRetention')
  })

  it.each([
    ['ad_pairwise_selection', { selection: 'KEEP_BOTH' }, { selection: 'KEEP_A' }],
    [
      'adset_profitability_selection',
      { winner: 'INSUFFICIENT_EVIDENCE', readiness: 'OBSERVE' },
      { winner: 'ADSET_A', readiness: 'READY_FOR_HUMAN_REVIEW' }
    ]
  ])(
    'does not interpret answer confidence as posterior evidence for %s',
    (task, expected, predicted) => {
      const cases = [fixture('confidence', task, expected)]
      const baseline = summarize(cases, [observation('confidence', predicted)])
      for (const confidence of [0, 0.5, 1]) {
        const report = summarize(cases, [
          observation('confidence', predicted, {
            answers: answers(predicted, confidence)
          })
        ])
        expect(report).toEqual(baseline)
        for (const question of measuredGroup(report).perQuestion) {
          expect(question).toMatchObject({ meanBrier: null, brierSamples: 0 })
        }
      }
      expect(baseline.productionBenefitProven).toBe(false)
    }
  )
})
