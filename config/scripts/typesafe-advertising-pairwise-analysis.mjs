const ARMS = ['typesafe', 'gemini', 'numeric_reference']
const CONDITIONS = ['current_only', 'with_baselines']

function stableSelection(item, observation) {
  if (observation?.status !== 'success') {
    return null
  }
  const value = observation.answers?.selection?.value
  const slots = item.experiment.adIdsBySlot
  if (value === 'INSUFFICIENT_DATA') {
    return 'insufficient'
  }
  if (value === 'KEEP_NEITHER') {
    return 'keep:[]'
  }
  const ids =
    value === 'KEEP_BOTH'
      ? [slots.A, slots.B]
      : value === 'KEEP_A'
        ? [slots.A]
        : value === 'KEEP_B'
          ? [slots.B]
          : null
  return ids ? `keep:${JSON.stringify(ids.sort())}` : null
}

function conditionSummary(cases, rows, condition) {
  const selected = cases.filter((item) => item.experiment.contextCondition === condition)
  const result = {
    cases: selected.length,
    successful: 0,
    correct: 0,
    supportedDecisions: 0,
    expectedDecisive: 0,
    actualDecisive: 0,
    unsafeDecisionsFromInsufficientEvidence: 0
  }
  for (const item of selected) {
    const row = rows.get(item.id)
    const expected = item.expected.selection.value
    const actual = row?.status === 'success' ? row.answers?.selection?.value : undefined
    if (expected !== 'INSUFFICIENT_DATA') {
      result.expectedDecisive++
    }
    if (actual === undefined) {
      continue
    }
    result.successful++
    if (actual === expected) {
      result.correct++
    }
    if (actual !== 'INSUFFICIENT_DATA') {
      result.actualDecisive++
      if (actual === expected) {
        result.supportedDecisions++
      }
      if (expected === 'INSUFFICIENT_DATA') {
        result.unsafeDecisionsFromInsufficientEvidence++
      }
    }
  }
  return result
}

function orderSummary(cases, rows) {
  const pairs = new Map()
  for (const item of cases) {
    const key = `${item.experiment.scenarioId}/${item.experiment.contextCondition}`
    if (!pairs.has(key)) {
      pairs.set(key, [])
    }
    pairs.get(key).push(item)
  }
  const result = {
    plannedPairs: pairs.size,
    completePairs: 0,
    stableAdIdAgreement: 0,
    disagreements: [],
    incompletePairs: 0
  }
  for (const [key, pair] of pairs) {
    const values = pair.map((item) => stableSelection(item, rows.get(item.id)))
    if (
      pair.length !== 2 ||
      new Set(pair.map((item) => item.experiment.presentationOrder)).size !== 2 ||
      values.some((value) => value === null)
    ) {
      result.incompletePairs++
      continue
    }
    result.completePairs++
    if (values[0] === values[1]) {
      result.stableAdIdAgreement++
    } else {
      result.disagreements.push(key)
    }
  }
  return result
}

export function summarizePairwiseExperiment(cases, observations) {
  const selected = cases.filter((item) => item.task === 'ad_pairwise_selection')
  return {
    unit: 'scenario family; four related presentations are not four independent examples',
    interpretation:
      'Context can legitimately change sufficient evidence and the correct label. Supported decisiveness is not causal profit uplift.',
    groups: ['all', 'development', 'holdout'].flatMap((split) => {
      const subset = selected.filter((item) => split === 'all' || item.split === split)
      if (!subset.length) {
        return []
      }
      return ARMS.map((arm) => {
        const rows = new Map(
          observations.filter((row) => row.arm === arm).map((row) => [row.caseId, row])
        )
        return {
          split,
          arm,
          scenarioFamilies: new Set(subset.map((item) => item.familyId)).size,
          context: Object.fromEntries(
            CONDITIONS.map((condition) => [condition, conditionSummary(subset, rows, condition)])
          ),
          order: orderSummary(subset, rows)
        }
      })
    })
  }
}
