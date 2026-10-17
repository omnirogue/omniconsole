import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const BASELINE_ARMS = ['existing_regex', 'numeric_reference']
const STATUSES = ['success', 'error', 'skipped']
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value)
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const observed = (row) => row?.status === 'success' || row?.status === 'error'
const keyFor = (caseId, arm) => JSON.stringify([caseId, arm])

function requireValid(condition, message) {
  if (!condition) {
    throw new Error(`Invalid evaluation: ${message}`)
  }
}

function validateValue(question, value, expected = false) {
  if (question.type === 'choice') {
    return (
      typeof value === 'string' && (!question.criteria || Object.hasOwn(question.criteria, value))
    )
  }
  if (!nonnegative(value)) {
    return false
  }
  if (question.type === 'noul') {
    return expected ? value === 0 || value === 1 : value <= 1
  }
  return !Array.isArray(question.criteria) || value <= question.criteria.length - 1
}

function indexCases(cases) {
  requireValid(
    Array.isArray(cases) && cases.length <= 1_000,
    'cases must be an array of at most 1000'
  )
  const byId = new Map()
  const questionTypes = new Map()
  for (const item of cases) {
    requireValid(record(item), 'case must be an object')
    requireValid(
      ['id', 'familyId', 'task', 'split'].every((field) => identifier(item[field])),
      'case identifiers'
    )
    requireValid(item.origin === 'authored_synthetic', 'origin must be authored_synthetic')
    requireValid(!byId.has(item.id), 'duplicate case ID')
    requireValid(
      record(item.questions) && record(item.expected),
      'questions and expected are required'
    )
    const questions = Object.entries(item.questions)
    requireValid(questions.length > 0 && questions.length <= 64, 'case needs 1..64 questions')
    requireValid(Object.keys(item.expected).length === questions.length, 'expected question IDs')
    for (const [id, question] of questions) {
      requireValid(identifier(id) && record(question), 'question ID or descriptor')
      requireValid(['choice', 'score', 'noul'].includes(question.type), 'question type')
      requireValid(Object.hasOwn(item.expected, id), 'missing expected question ID')
      const label = item.expected[id]
      requireValid(record(label) && validateValue(question, label.value, true), 'expected value')
      requireValid(
        label.tolerance === undefined || nonnegative(label.tolerance),
        'expected tolerance'
      )
      const key = keyFor(item.task, id)
      requireValid(
        !questionTypes.has(key) || questionTypes.get(key) === question.type,
        'inconsistent question type'
      )
      questionTypes.set(key, question.type)
    }
    byId.set(item.id, item)
  }
  return byId
}

function indexObservations(observations, cases, arms) {
  requireValid(
    Array.isArray(observations) && observations.length <= 3_000,
    'observations must be an array of at most 3000'
  )
  const indexed = new Map()
  for (const row of observations) {
    requireValid(record(row), 'observation must be an object')
    requireValid(identifier(row.caseId) && cases.has(row.caseId), 'unknown case ID')
    requireValid(arms.includes(row.arm) && STATUSES.includes(row.status), 'arm or status')
    const key = keyFor(row.caseId, row.arm)
    requireValid(!indexed.has(key), 'duplicate case/arm observation')
    requireValid(nonnegative(row.elapsedMs), 'elapsedMs must be finite and nonnegative')
    requireValid(
      row.estimatedCostUsd === undefined || nonnegative(row.estimatedCostUsd),
      'estimatedCostUsd'
    )
    if (row.usage !== undefined) {
      requireValid(record(row.usage), 'usage')
      for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
        const value = row.usage[field]
        requireValid(
          (field === 'thinkingTokens' && value === undefined) ||
            (Number.isSafeInteger(value) && value >= 0),
          `usage.${field}`
        )
      }
    }
    requireValid(row.answers === undefined || record(row.answers), 'answers')
    for (const [id, answer] of Object.entries(row.answers ?? {})) {
      const item = cases.get(row.caseId)
      requireValid(Object.hasOwn(item.questions, id), 'unknown answer question ID')
      requireValid(
        record(answer) && validateValue(item.questions[id], answer.value),
        'answer value'
      )
      requireValid(
        answer.confidence === undefined ||
          (nonnegative(answer.confidence) && answer.confidence <= 1),
        'answer confidence'
      )
    }
    indexed.set(key, row)
  }
  return indexed
}

function correctness(correct, total) {
  if (total === 0) {
    return { correct, total, accuracy: null, wilson95: null }
  }
  const accuracy = correct / total
  const z = 1.959963984540054
  const denominator = 1 + z ** 2 / total
  const center = (accuracy + z ** 2 / (2 * total)) / denominator
  const margin =
    (z * Math.sqrt((accuracy * (1 - accuracy)) / total + z ** 2 / (4 * total ** 2))) / denominator
  return {
    correct,
    total,
    accuracy,
    wilson95: { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) }
  }
}

function scoredQuestions(item, row) {
  return Object.entries(item.questions).map(([id, question]) => {
    const expected = item.expected[id].value
    const answer =
      row?.status === 'success' && row.answers && Object.hasOwn(row.answers, id)
        ? row.answers[id]
        : undefined
    const predicted =
      answer === undefined
        ? null
        : question.type === 'noul'
          ? Number(answer.value >= 0.5)
          : answer.value
    const correct =
      predicted !== null &&
      (typeof expected === 'number' && question.type !== 'noul'
        ? Math.abs(predicted - expected) <= (item.expected[id].tolerance ?? 0)
        : predicted === expected)
    return { id, type: question.type, expected, predicted, correct, probability: answer?.value }
  })
}

function countValues(values) {
  const counts = new Map()
  for (const value of values) {
    counts.set(String(value), (counts.get(String(value)) ?? 0) + 1)
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

function criticalPositive(task, id, type) {
  if (task === 'evidence_support' && (id === 'decision' || id === 'supported')) {
    return type === 'noul' ? 1 : 'supports'
  }
  if (type === 'choice' && task === 'ad_sibling_selection') {
    return 'PAUSE'
  }
  if (type === 'choice' && task === 'ad_recommendation_audit') {
    return 'supported'
  }
  if (type === 'choice' && task === 'adset_profitability_selection' && id === 'readiness') {
    return 'READY_FOR_HUMAN_REVIEW'
  }
  return null
}

function unsafePairwiseSelection({ expected, predicted }) {
  if (!['KEEP_A', 'KEEP_B', 'KEEP_BOTH', 'KEEP_NEITHER'].includes(predicted)) {
    return false
  }
  return (
    expected === 'INSUFFICIENT_DATA' ||
    (predicted === 'KEEP_NEITHER' && expected !== 'KEEP_NEITHER') ||
    (['KEEP_A', 'KEEP_BOTH'].includes(expected) && !['KEEP_A', 'KEEP_BOTH'].includes(predicted)) ||
    (['KEEP_B', 'KEEP_BOTH'].includes(expected) && !['KEEP_B', 'KEEP_BOTH'].includes(predicted))
  )
}

function criticalCounts(task, id, type, entries) {
  if (type === 'choice' && task === 'ad_pairwise_selection' && id === 'selection') {
    return {
      criticalFalsePositiveOpportunities: entries.filter(
        (entry) => entry.expected !== 'KEEP_NEITHER'
      ).length,
      criticalFalsePositives: entries.filter(unsafePairwiseSelection).length
    }
  }
  const positive = criticalPositive(task, id, type)
  return {
    criticalFalsePositiveOpportunities:
      positive === null ? null : entries.filter((entry) => entry.expected !== positive).length,
    criticalFalsePositives:
      positive === null
        ? null
        : entries.filter((entry) => entry.expected !== positive && entry.predicted === positive)
            .length
  }
}

function adAbstentionLabel(task, id) {
  if (task === 'ad_sibling_selection') {
    return 'NO_ACTION'
  }
  if (task === 'ad_creative_alignment' || task === 'ad_recommendation_audit') {
    return 'uncertain'
  }
  if (task === 'ad_pairwise_selection' && id === 'selection') {
    return 'INSUFFICIENT_DATA'
  }
  if (task === 'adset_profitability_selection') {
    if (id === 'winner') {
      return 'INSUFFICIENT_EVIDENCE'
    }
    if (id === 'readiness') {
      return 'OBSERVE'
    }
  }
  return null
}

function adDecisionMetrics(task, id, type, entries) {
  const label = adAbstentionLabel(task, id)
  if (type !== 'choice' || label === null) {
    return {}
  }
  const siblings = task === 'ad_sibling_selection'
  const expected = entries.filter((entry) => entry.expected === label)
  const winners = entries.filter((entry) => entry.expected === 'KEEP_RUNNING')
  return {
    ...(siblings
      ? {
          winnerRetention: {
            eligible: winners.length,
            retained: winners.filter((entry) => entry.predicted === 'KEEP_RUNNING').length,
            needlessPauses: winners.filter((entry) => entry.predicted === 'PAUSE').length
          }
        }
      : {}),
    abstention: {
      label,
      expected: expected.length,
      actual: entries.filter((entry) => entry.predicted === label).length,
      correct: expected.filter((entry) => entry.predicted === label).length,
      missed: expected.filter((entry) => entry.predicted !== null && entry.predicted !== label)
        .length,
      unnecessary: entries.filter((entry) => entry.expected !== label && entry.predicted === label)
        .length,
      missing: expected.filter((entry) => entry.predicted === null).length
    }
  }
}

function perQuestionSummary(task, id, entries) {
  const answered = entries.filter((entry) => entry.predicted !== null)
  const confusion = new Map()
  for (const { expected, predicted } of answered) {
    const key = JSON.stringify([expected, predicted])
    const cell = confusion.get(key) ?? { expected, predicted, count: 0 }
    cell.count++
    confusion.set(key, cell)
  }
  const type = entries[0].type
  const brier =
    type === 'noul' ? answered.map((entry) => (entry.probability - entry.expected) ** 2) : []
  return {
    id,
    type,
    ...correctness(entries.filter((entry) => entry.correct).length, entries.length),
    answered: answered.length,
    missing: entries.length - answered.length,
    expectedDistribution: countValues(entries.map((entry) => entry.expected)),
    predictedDistribution: countValues(answered.map((entry) => entry.predicted)),
    confusion: [...confusion.values()],
    ...criticalCounts(task, id, type, entries),
    brierSamples: brier.length,
    meanBrier: brier.length ? brier.reduce((sum, value) => sum + value, 0) / brier.length : null,
    ...adDecisionMetrics(task, id, type, entries)
  }
}

function latency(values) {
  if (!values.length) {
    return null
  }
  const summary = summarizeBenchmarkSamples(values)
  requireValid(Object.values(summary).every(Number.isFinite), 'latency summary overflow')
  return summary
}

function reportedMetric(rows, valueFor) {
  const values = rows.map(valueFor).filter((value) => value !== undefined)
  const total = values.length ? values.reduce((sum, value) => sum + value, 0) : null
  requireValid(total === null || Number.isFinite(total), 'reported metric overflow')
  return {
    eligible: rows.length,
    reported: values.length,
    total,
    missing: rows.length - values.length
  }
}

function groupSummary(task, split, arm, cases, indexed) {
  const rows = cases.map((item) => indexed.get(keyFor(item.id, arm)))
  const attempted = rows.filter(observed)
  const successful = rows.filter((row) => row?.status === 'success')
  const perCase = cases.map((item, index) => scoredQuestions(item, rows[index]))
  const questions = perCase.flat()
  const byQuestion = new Map()
  for (const question of questions) {
    if (!byQuestion.has(question.id)) {
      byQuestion.set(question.id, [])
    }
    byQuestion.get(question.id).push(question)
  }
  const notApplicable =
    rows.length > 0 &&
    rows.every((row) => row?.status === 'skipped' && row.errorCode === 'not_applicable')
  return {
    task,
    split,
    arm,
    cases: cases.length,
    attempted: attempted.length,
    success: successful.length,
    errors: rows.filter((row) => row?.status === 'error').length,
    skipped: rows.filter((row) => row?.status === 'skipped').length,
    missing: rows.filter((row) => row === undefined).length,
    applicability: notApplicable ? 'not_applicable' : 'applicable',
    quality: notApplicable
      ? null
      : {
          cases: correctness(
            perCase.filter((entries) => entries.every((entry) => entry.correct)).length,
            cases.length
          ),
          questions: correctness(
            questions.filter((entry) => entry.correct).length,
            questions.length
          )
        },
    latency: {
      successful: latency(successful.map((row) => row.elapsedMs)),
      attempted: latency(attempted.map((row) => row.elapsedMs))
    },
    usage: Object.fromEntries(
      ['inputTokens', 'outputTokens', 'thinkingTokens'].map((field) => [
        field,
        reportedMetric(attempted, (row) => row.usage?.[field])
      ])
    ),
    cost: reportedMetric(attempted, (row) => row.estimatedCostUsd),
    perQuestion: [...byQuestion].map(([id, entries]) => ({
      ...perQuestionSummary(task, id, entries),
      ...(notApplicable ? { accuracy: null, wilson95: null } : {})
    }))
  }
}

function pairedSummary(task, split, cases, indexed, rightArm) {
  const pairs = cases.map((item) => ({
    item,
    left: indexed.get(keyFor(item.id, 'typesafe')),
    right: indexed.get(keyFor(item.id, rightArm))
  }))
  const comparable = pairs.filter(({ left, right }) => observed(left) && observed(right))
  const successful = comparable.filter(
    ({ left, right }) => left.status === 'success' && right.status === 'success'
  )
  const costPairs = successful.filter(
    ({ left, right }) => left.estimatedCostUsd !== undefined && right.estimatedCostUsd !== undefined
  )
  const differences = comparable.map(
    ({ item, left, right }) =>
      scoredQuestions(item, left).filter((question) => question.correct).length -
      scoredQuestions(item, right).filter((question) => question.correct).length
  )
  const leftCost = reportedMetric(
    costPairs.map(({ left }) => left),
    (row) => row.estimatedCostUsd
  ).total
  const rightCost = reportedMetric(
    costPairs.map(({ right }) => right),
    (row) => row.estimatedCostUsd
  ).total
  return {
    task,
    split,
    leftArm: 'typesafe',
    rightArm,
    cases: cases.length,
    bothObserved: pairs.filter(({ left, right }) => left !== undefined && right !== undefined)
      .length,
    compared: comparable.length,
    bothSuccessful: successful.length,
    wins: differences.filter((difference) => difference > 0).length,
    losses: differences.filter((difference) => difference < 0).length,
    ties: differences.filter((difference) => difference === 0).length,
    unpaired: cases.length - comparable.length,
    latency: {
      matched: successful.length,
      unmatched: cases.length - successful.length,
      left: latency(successful.map(({ left }) => left.elapsedMs)),
      right: latency(successful.map(({ right }) => right.elapsedMs)),
      deltaMs: latency(successful.map(({ left, right }) => left.elapsedMs - right.elapsedMs))
    },
    cost: {
      matched: costPairs.length,
      unmatched: cases.length - costPairs.length,
      leftTotalUsd: leftCost,
      rightTotalUsd: rightCost,
      deltaUsd: costPairs.length ? leftCost - rightCost : null
    }
  }
}

export function summarizeEvaluation(cases, observations, options = {}) {
  requireValid(record(options), 'options must be an object')
  const rightArm = options.rightArm === undefined ? 'gemini' : options.rightArm
  requireValid(['gemini', 'laya-local'].includes(rightArm), 'comparison arm')
  const baselineArm = options.baselineArm === undefined ? 'existing_regex' : options.baselineArm
  requireValid(
    BASELINE_ARMS.includes(baselineArm),
    'baselineArm must be existing_regex or numeric_reference'
  )
  const arms = ['typesafe', rightArm, baselineArm]
  const byId = indexCases(cases)
  const indexed = indexObservations(observations, byId, arms)
  const partitions = new Map()
  for (const item of cases) {
    const key = keyFor(item.task, item.split)
    if (!partitions.has(key)) {
      partitions.set(key, { task: item.task, split: item.split, cases: [] })
    }
    partitions.get(key).cases.push(item)
  }
  return {
    schemaVersion: 1,
    productionBenefitProven: false,
    evidence: {
      origin: 'authored_synthetic',
      independentLabels: false,
      productionBenefitProven: false,
      qualityLabel:
        'Agreement with authored synthetic expected values; not independent ground truth.',
      intervalLabel:
        'Wilson 95% descriptive intervals; synthetic family dependence is not adjusted.',
      denominatorPolicy:
        'Quality includes every assigned case and question, including errors, missing and skips; entirely not_applicable groups have no quality claim.',
      comparisonPolicy:
        'Paired wins compare correct-question counts for the same case IDs with both arms attempted; failed calls score zero, and missing or skipped pairs are reported as unpaired.',
      costPolicy:
        'Reported estimated cost only, with coverage; matched successful pairs only. No inferred production savings.',
      promotion: 'No automatic promotion or production policy change.'
    },
    totals: {
      cases: cases.length,
      questions: cases.reduce((sum, item) => sum + Object.keys(item.questions).length, 0),
      observations: observations.length
    },
    groups: [...partitions.values()].flatMap(({ task, split, cases: items }) =>
      arms.map((arm) => groupSummary(task, split, arm, items, indexed))
    ),
    paired: [...partitions.values()].map(({ task, split, cases: items }) =>
      pairedSummary(task, split, items, indexed, rightArm)
    )
  }
}
