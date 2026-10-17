import { describe, expect, it } from 'vitest'

import { summarizeEvaluation } from './typesafe-evaluation-metrics.mjs'

function fixture(id = 'case-1', overrides = {}) {
  return {
    id,
    familyId: `family-${id}`,
    split: 'holdout',
    origin: 'authored_synthetic',
    task: 'evidence_support',
    state: { claim: 'A synthetic claim.', evidence: 'Synthetic evidence.' },
    questions: {
      decision: {
        type: 'choice',
        instructions: 'Classify support.',
        criteria: { supports: 'Supported.', contradicts: 'Contradicted.', insufficient: 'Unknown.' }
      },
      score: { type: 'score', instructions: 'Score support.' }
    },
    expected: { decision: { value: 'supports' }, score: { value: 1 } },
    rationale: 'Authored synthetic label for regression coverage.',
    ...overrides
  }
}

function observation(caseId, overrides = {}) {
  return {
    caseId,
    arm: 'typesafe',
    status: 'success',
    elapsedMs: 10,
    answers: { decision: { value: 'supports' }, score: { value: 1 } },
    ...overrides
  }
}

function group(report, arm = 'typesafe', task = 'evidence_support', split = 'holdout') {
  return report.groups.find(
    (entry) => entry.arm === arm && entry.task === task && entry.split === split
  )
}

function answerValues(values) {
  return Object.fromEntries(Object.entries(values).map(([id, value]) => [id, { value }]))
}

function adFixture(id, task, values) {
  return fixture(id, {
    task,
    questions: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        {
          type: typeof value === 'number' ? 'noul' : 'choice',
          instructions: 'Evaluate the synthetic ad.'
        }
      ])
    ),
    expected: answerValues(values)
  })
}

describe('TypeSafe evaluation metrics', () => {
  it('selects the numeric baseline without mutating options or changing the default report', () => {
    const cases = [fixture()]
    const rows = [observation('case-1', { arm: 'existing_regex' })]
    const defaults = summarizeEvaluation(cases, rows)
    expect(summarizeEvaluation(cases, rows, { baselineArm: 'existing_regex' })).toEqual(defaults)
    const options = Object.freeze({ baselineArm: 'numeric_reference' })
    const numeric = summarizeEvaluation(
      cases,
      [
        observation('case-1', {
          arm: 'numeric_reference'
        })
      ],
      options
    )
    expect(numeric.groups.map(({ arm }) => arm)).toEqual([
      'typesafe',
      'gemini',
      'numeric_reference'
    ])
    expect(group(numeric, 'numeric_reference').quality).toEqual(
      group(defaults, 'existing_regex').quality
    )
    expect(options).toEqual({ baselineArm: 'numeric_reference' })
    expect(summarizeEvaluation(cases, rows)).toEqual(defaults)
    for (const question of defaults.groups.flatMap(({ perQuestion }) => perQuestion)) {
      expect(question).not.toHaveProperty('abstention')
      expect(question).not.toHaveProperty('winnerRetention')
    }
  })

  it.each([
    ['unknown', 'typesafe'],
    ['typesafe', 'typesafe'],
    ['gemini', 'gemini'],
    ['existing_regex', 'numeric_reference'],
    ['numeric_reference', 'existing_regex'],
    [undefined, 'numeric_reference']
  ])('rejects baseline %j with observation arm %j', (baselineArm, arm) => {
    expect(() =>
      summarizeEvaluation([fixture()], [observation('case-1', { arm })], {
        baselineArm
      })
    ).toThrow()
  })

  it('counts three-ad case accuracy, unsafe pauses, winner retention and missing abstentions', () => {
    const task = 'ad_sibling_selection'
    const expected = { ad_a: 'KEEP_RUNNING', ad_b: 'PAUSE', ad_c: 'NO_ACTION' }
    const selections = [
      ['complete', expected],
      ['unsafe', { ad_a: 'PAUSE', ad_b: 'NO_ACTION', ad_c: 'PAUSE' }],
      ['abstain', { ...expected, ad_a: 'NO_ACTION' }],
      ['missed', { ...expected, ad_c: 'KEEP_RUNNING' }],
      ['partial', { ad_a: 'KEEP_RUNNING', ad_b: 'PAUSE' }],
      ['error', expected]
    ]
    const cases = [
      ...selections.map(([id]) => adFixture(id, task, expected)),
      adFixture('absent', task, expected)
    ]
    const rows = selections.map(([id, values]) =>
      observation(id, {
        status: id === 'error' ? 'error' : 'success',
        answers: answerValues(values)
      })
    )
    const actual = group(summarizeEvaluation(cases, rows), 'typesafe', task)
    expect(actual.quality).toMatchObject({
      cases: { correct: 1, total: 7, accuracy: 1 / 7 },
      questions: { correct: 9, total: 21, accuracy: 9 / 21 }
    })
    const questions = Object.fromEntries(
      actual.perQuestion.map((question) => [question.id, question])
    )
    expect(questions.ad_a.winnerRetention).toEqual({ eligible: 7, retained: 3, needlessPauses: 1 })
    expect(questions.ad_a).toMatchObject({
      criticalFalsePositives: 1,
      criticalFalsePositiveOpportunities: 7
    })
    expect(questions.ad_a.abstention).toMatchObject({ actual: 1, unnecessary: 1 })
    expect(questions.ad_b).toMatchObject({
      criticalFalsePositives: 0,
      criticalFalsePositiveOpportunities: 0
    })
    expect(questions.ad_c).toMatchObject({
      criticalFalsePositives: 1,
      criticalFalsePositiveOpportunities: 7
    })
    expect(questions.ad_c.abstention).toEqual({
      label: 'NO_ACTION',
      expected: 7,
      actual: 2,
      correct: 2,
      missed: 2,
      unnecessary: 0,
      missing: 3
    })
  })

  it.each([
    ['ad_creative_alignment', 'mismatch', 'aligned', null],
    ['ad_recommendation_audit', 'unsupported', 'supported', 2]
  ])('reports uncertainty and dangerous positives for %s', (task, negative, positive, critical) => {
    const numeric = task === 'ad_creative_alignment' ? { needs_review: 1 } : {}
    const labels = [negative, 'uncertain', 'uncertain', positive, 'uncertain']
    const predictions = [positive, 'uncertain', positive, 'uncertain', undefined]
    const cases = labels.map((decision, index) =>
      adFixture(`ad-${index}`, task, { decision, ...numeric })
    )
    const rows = predictions.map((decision, index) =>
      observation(`ad-${index}`, {
        answers: decision === undefined ? {} : answerValues({ decision, ...numeric })
      })
    )
    const actual = group(summarizeEvaluation(cases, rows), 'typesafe', task)
    const decision = actual.perQuestion.find(({ id }) => id === 'decision')
    expect(decision.criticalFalsePositives).toBe(critical)
    expect(decision.abstention).toEqual({
      label: 'uncertain',
      expected: 3,
      actual: 2,
      correct: 1,
      missed: 1,
      unnecessary: 1,
      missing: 1
    })
    expect(decision).not.toHaveProperty('winnerRetention')
    expect(decision.meanBrier).toBeNull()
    if (task === 'ad_creative_alignment') {
      const review = actual.perQuestion.find(({ id }) => id === 'needs_review')
      expect(review).not.toHaveProperty('abstention')
      expect(review).not.toHaveProperty('winnerRetention')
      expect(review).toMatchObject({ meanBrier: 0, brierSamples: 4 })
    } else {
      expect(decision.criticalFalsePositiveOpportunities).toBe(4)
    }
  })

  it('does not turn synthetic labels or an empty report into production evidence', () => {
    expect(summarizeEvaluation([], [])).toMatchObject({
      schemaVersion: 1,
      evidence: { origin: 'authored_synthetic', independentLabels: false },
      productionBenefitProven: false,
      totals: { cases: 0, questions: 0, observations: 0 },
      groups: [],
      paired: []
    })
  })

  it('keeps partial answers, errors, skips and absent observations in quality denominators', () => {
    const cases = ['complete', 'partial', 'failed', 'skipped', 'absent'].map((id) => fixture(id))
    const report = summarizeEvaluation(cases, [
      observation('complete', {
        elapsedMs: 20,
        usage: { inputTokens: 10, outputTokens: 0, thinkingTokens: 0 },
        estimatedCostUsd: 0
      }),
      observation('partial', { elapsedMs: 40, answers: { decision: { value: 'supports' } } }),
      observation('failed', {
        status: 'error',
        elapsedMs: 100,
        usage: { inputTokens: 5, outputTokens: 2 },
        estimatedCostUsd: 0.1
      }),
      observation('skipped', { status: 'skipped', elapsedMs: 0, answers: undefined })
    ])
    const actual = group(report)
    expect(report.totals).toEqual({ cases: 5, questions: 10, observations: 4 })
    expect(actual).toMatchObject({
      cases: 5,
      attempted: 3,
      success: 2,
      errors: 1,
      skipped: 1,
      missing: 1,
      quality: {
        cases: { correct: 1, total: 5, accuracy: 0.2 },
        questions: { correct: 3, total: 10, accuracy: 0.3 }
      },
      latency: {
        successful: { samples: 2, medianMs: 30, p95Ms: 40, minMs: 20, maxMs: 40 },
        attempted: { samples: 3, medianMs: 40, p95Ms: 100, minMs: 20, maxMs: 100 }
      },
      usage: {
        inputTokens: { eligible: 3, reported: 2, total: 15, missing: 1 },
        outputTokens: { eligible: 3, reported: 2, total: 2, missing: 1 },
        thinkingTokens: { eligible: 3, reported: 1, total: 0, missing: 2 }
      },
      cost: { eligible: 3, reported: 2, total: 0.1, missing: 1 }
    })
    expect(actual.perQuestion.find(({ id }) => id === 'score')).toMatchObject({
      total: 5,
      answered: 1,
      missing: 4,
      correct: 1,
      accuracy: 0.2
    })
    expect(actual.quality.cases.wilson95.lower).toBeCloseTo(0.036224, 5)
    expect(actual.quality.cases.wilson95.upper).toBeCloseTo(0.624465, 5)
    expect(report.productionBenefitProven).toBe(false)
  })

  it('distinguishes unreported spend from a reported zero', () => {
    const report = summarizeEvaluation(
      [fixture()],
      [observation('case-1'), observation('case-1', { arm: 'gemini', estimatedCostUsd: 0 })]
    )
    expect(group(report).cost).toEqual({ eligible: 1, reported: 0, total: null, missing: 1 })
    expect(group(report).usage.inputTokens).toEqual({
      eligible: 1,
      reported: 0,
      total: null,
      missing: 1
    })
    expect(group(report, 'gemini').cost).toEqual({ eligible: 1, reported: 1, total: 0, missing: 0 })
  })

  it('keeps tasks, splits and provider arms separate', () => {
    const report = summarizeEvaluation(
      [
        fixture('holdout'),
        fixture('train', { split: 'train' }),
        fixture('other', { task: 'intent_classification' })
      ],
      [
        observation('holdout'),
        observation('train', { answers: {} }),
        observation('other', { arm: 'gemini' }),
        observation('holdout', { arm: 'existing_regex', answers: {} })
      ]
    )
    expect(group(report).quality.cases).toMatchObject({ correct: 1, total: 1 })
    expect(group(report, 'typesafe', 'evidence_support', 'train').quality.cases).toMatchObject({
      correct: 0,
      total: 1
    })
    expect(group(report, 'gemini', 'intent_classification').quality.cases).toMatchObject({
      correct: 1,
      total: 1
    })
    expect(group(report, 'existing_regex').quality.cases).toMatchObject({ correct: 0, total: 1 })
    expect(
      report.paired.every(
        ({ leftArm, rightArm }) => leftArm === 'typesafe' && rightArm === 'gemini'
      )
    ).toBe(true)
  })

  it('classifies Noul at 0.5, ignores numeric tolerance, and scores raw probabilities with Brier loss', () => {
    const cases = [1, 0, 0].map((value, index) =>
      fixture(`noul-${index}`, {
        questions: { supported: { type: 'noul', instructions: 'Is the claim supported?' } },
        expected: { supported: { value, tolerance: 1 } }
      })
    )
    const report = summarizeEvaluation(
      cases,
      [0.5, 0.49, 0.9].map((value, index) =>
        observation(`noul-${index}`, { answers: { supported: { value } } })
      )
    )
    const question = group(report).perQuestion[0]
    expect(question).toMatchObject({
      id: 'supported',
      type: 'noul',
      total: 3,
      answered: 3,
      missing: 0,
      correct: 2,
      accuracy: 2 / 3,
      expectedDistribution: { 0: 2, 1: 1 },
      predictedDistribution: { 0: 1, 1: 2 },
      criticalFalsePositives: 1
    })
    expect(question.confusion).toEqual(
      expect.arrayContaining([
        { expected: 1, predicted: 1, count: 1 },
        { expected: 0, predicted: 0, count: 1 },
        { expected: 0, predicted: 1, count: 1 }
      ])
    )
    expect(question.meanBrier).toBeCloseTo((0.25 + 0.2401 + 0.81) / 3)
  })

  it('counts unsupported positive decisions as critical false positives only in evidence support', () => {
    const labels = ['contradicts', 'insufficient', 'supports', 'contradicts']
    const predictions = ['supports', 'supports', 'contradicts', 'insufficient']
    const cases = labels.map((value, index) =>
      fixture(`choice-${index}`, {
        expected: { decision: { value }, score: { value: 1 } }
      })
    )
    cases.push(
      fixture('other-task', {
        task: 'intent_classification',
        expected: { decision: { value: 'contradicts' }, score: { value: 1 } }
      })
    )
    const report = summarizeEvaluation(cases, [
      ...predictions.map((value, index) =>
        observation(`choice-${index}`, {
          answers: { decision: { value }, score: { value: 1 } }
        })
      ),
      observation('other-task')
    ])
    expect(group(report).perQuestion.find(({ id }) => id === 'decision')).toMatchObject({
      correct: 0,
      criticalFalsePositives: 2,
      meanBrier: null,
      expectedDistribution: { contradicts: 2, insufficient: 1, supports: 1 },
      predictedDistribution: { supports: 2, contradicts: 1, insufficient: 1 }
    })
    expect(
      group(report, 'typesafe', 'intent_classification').perQuestion.find(
        ({ id }) => id === 'decision'
      ).criticalFalsePositives
    ).toBeNull()
  })

  it('applies inclusive score tolerance and defaults to exact equality', () => {
    const cases = [
      fixture('tolerated', {
        expected: { decision: { value: 'supports' }, score: { value: 1, tolerance: 0.125 } }
      }),
      fixture('exact'),
      fixture('outside', {
        expected: { decision: { value: 'supports' }, score: { value: 1, tolerance: 0.125 } }
      })
    ]
    const report = summarizeEvaluation(
      cases,
      [1.125, 1.01, 1.25].map((value, index) =>
        observation(cases[index].id, {
          answers: { decision: { value: 'supports' }, score: { value } }
        })
      )
    )
    expect(group(report).perQuestion.find(({ id }) => id === 'score')).toMatchObject({
      correct: 1,
      total: 3
    })
  })

  it('reports an explicitly inapplicable baseline without claiming measured accuracy or latency', () => {
    const report = summarizeEvaluation(
      [fixture()],
      [
        observation('case-1', {
          arm: 'existing_regex',
          status: 'skipped',
          elapsedMs: 0,
          answers: undefined,
          errorCode: 'not_applicable'
        })
      ]
    )
    expect(group(report, 'existing_regex')).toMatchObject({
      applicability: 'not_applicable',
      quality: null,
      attempted: 0,
      skipped: 1,
      errors: 0,
      latency: { successful: null, attempted: null },
      cost: { eligible: 0, reported: 0, total: null, missing: 0 }
    })
    expect(
      group(report, 'existing_regex').perQuestion.every(
        ({ accuracy, wilson95 }) => accuracy === null && wilson95 === null
      )
    ).toBe(true)
  })

  it('retains all-failed denominators without claiming successful latency or matched costs', () => {
    const report = summarizeEvaluation(
      [fixture()],
      ['typesafe', 'gemini'].map((arm) =>
        observation('case-1', { arm, status: 'error', answers: undefined, estimatedCostUsd: 0.1 })
      )
    )
    for (const arm of ['typesafe', 'gemini']) {
      expect(group(report, arm)).toMatchObject({
        attempted: 1,
        success: 0,
        errors: 1,
        quality: {
          cases: { correct: 0, total: 1, accuracy: 0 },
          questions: { correct: 0, total: 2, accuracy: 0 }
        },
        latency: { successful: null, attempted: { samples: 1, medianMs: 10 } }
      })
    }
    expect(report.paired[0]).toMatchObject({
      bothObserved: 1,
      bothSuccessful: 0,
      wins: 0,
      losses: 0,
      ties: 1,
      unpaired: 0,
      latency: { matched: 0, left: null, right: null, deltaMs: null },
      cost: { matched: 0, leftTotalUsd: null, rightTotalUsd: null, deltaUsd: null }
    })
  })

  it('compares matched quality including errors while matching successful latency and reported costs separately', () => {
    const cases = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => fixture(id))
    const wrong = { decision: { value: 'contradicts' }, score: { value: 0 } }
    const report = summarizeEvaluation(cases, [
      observation('a', { elapsedMs: 10, estimatedCostUsd: 0 }),
      observation('a', { arm: 'gemini', elapsedMs: 20, estimatedCostUsd: 0.2 }),
      observation('b', { elapsedMs: 100, answers: wrong, estimatedCostUsd: 0.3 }),
      observation('b', { arm: 'gemini', elapsedMs: 40 }),
      observation('c', { estimatedCostUsd: 3 }),
      observation('c', { arm: 'gemini', status: 'error', answers: undefined, estimatedCostUsd: 4 }),
      observation('d', { status: 'error', answers: undefined }),
      observation('d', { arm: 'gemini', answers: wrong }),
      observation('e', { arm: 'gemini' }),
      observation('f', { status: 'skipped', answers: undefined }),
      observation('f', { arm: 'gemini' }),
      observation('g', {
        elapsedMs: 30,
        answers: { decision: { value: 'supports' } },
        estimatedCostUsd: 0.1
      }),
      observation('g', { arm: 'gemini', elapsedMs: 30, answers: wrong, estimatedCostUsd: 0.4 })
    ])
    const paired = report.paired.find(
      ({ task, split }) => task === 'evidence_support' && split === 'holdout'
    )
    expect(paired).toMatchObject({
      cases: 7,
      bothObserved: 6,
      bothSuccessful: 3,
      wins: 2,
      losses: 1,
      ties: 2,
      unpaired: 2,
      latency: {
        matched: 3,
        left: { samples: 3, medianMs: 30, p95Ms: 100, minMs: 10, maxMs: 100 },
        right: { samples: 3, medianMs: 30, p95Ms: 40, minMs: 20, maxMs: 40 },
        deltaMs: { samples: 3, medianMs: 0, p95Ms: 60, minMs: -10, maxMs: 60 }
      },
      cost: { matched: 2, leftTotalUsd: 0.1 }
    })
    expect(paired.cost.rightTotalUsd).toBeCloseTo(0.6)
    expect(paired.cost.deltaUsd).toBeCloseTo(-0.5)
  })

  it('does not create paired ties or zero-cost claims from an absent comparison arm', () => {
    const report = summarizeEvaluation([fixture()], [observation('case-1')])
    expect(report.paired[0]).toMatchObject({
      bothObserved: 0,
      bothSuccessful: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      unpaired: 1,
      latency: { matched: 0, left: null, right: null, deltaMs: null },
      cost: { matched: 0, leftTotalUsd: null, rightTotalUsd: null, deltaUsd: null }
    })
  })

  it('leaves caller-owned cases and observations unchanged', () => {
    const cases = [fixture()]
    const observations = [observation('case-1')]
    const before = structuredClone({ cases, observations })
    summarizeEvaluation(cases, observations)
    expect({ cases, observations }).toEqual(before)
  })

  it.each([
    { id: '' },
    { id: ' ' },
    { familyId: '' },
    { task: '' },
    { split: '' },
    { origin: 'production' },
    { questions: {} },
    { expected: { decision: { value: 'supports' }, absent: { value: 1 } } },
    { expected: { decision: { value: 'unknown' }, score: { value: 1 } } },
    { expected: { decision: { value: 'supports' }, score: { value: Number.NaN } } },
    { expected: { decision: { value: 'supports' }, score: { value: 1, tolerance: -1 } } }
  ])('rejects malformed case metadata or labels: %j', (overrides) => {
    expect(() => summarizeEvaluation([fixture('case-1', overrides)], [])).toThrow()
  })

  it.each([
    { caseId: 'unknown' },
    { arm: 'unknown' },
    { status: 'unknown' },
    { elapsedMs: -1 },
    { elapsedMs: Infinity },
    { elapsedMs: Number.NaN },
    { estimatedCostUsd: -1 },
    { estimatedCostUsd: Infinity },
    { usage: { inputTokens: -1, outputTokens: 0 } },
    { usage: { inputTokens: 0, outputTokens: Number.NaN } },
    { usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: -1 } },
    { answers: { unknown: { value: 1 } } },
    { answers: { decision: { value: 'unknown' } } },
    { answers: { decision: { value: 1 } } },
    { answers: { score: { value: '1' } } },
    { answers: { score: { value: Infinity } } },
    { answers: { decision: { value: 'supports', confidence: 1.1 } } }
  ])('rejects invalid observations instead of contaminating metrics: %j', (overrides) => {
    expect(() => summarizeEvaluation([fixture()], [observation('case-1', overrides)])).toThrow()
  })

  it('rejects duplicate cases and duplicate observations for one arm', () => {
    expect(() => summarizeEvaluation([fixture(), fixture()], [])).toThrow()
    expect(() =>
      summarizeEvaluation([fixture()], [observation('case-1'), observation('case-1')])
    ).toThrow()
  })

  it.each([-0.01, 1.01, '0.5', Number.NaN])('rejects invalid Noul probability %j', (value) => {
    const input = fixture('case-1', {
      questions: { supported: { type: 'noul', instructions: 'Check support.' } },
      expected: { supported: { value: 1 } }
    })
    expect(() =>
      summarizeEvaluation([input], [observation('case-1', { answers: { supported: { value } } })])
    ).toThrow()
  })
})
