import { getDecisionRecipe } from './decision-recipe-registry.mjs'
import { validateDecisionRecordLedger } from './decision-record-contract.mjs'
import {
  recipeMean as mean,
  recipeLabelMetrics,
  summarizeRecipePairs
} from './decision-recipe-outcomes.mjs'
import {
  reliabilityBands,
  wilsonInterval,
  rankedProbabilityScore
} from './decision-calibration-statistics.mjs'

function questionCalibration(question, id, pairs) {
  const labelled = pairs.filter(({ outcome }) => outcome.labels[id] !== null)
  const scored = labelled
    .filter(({ observation }) => observation.status === 'success')
    .map(({ observation, outcome }) => ({
      answer: observation.answers[id],
      label: outcome.labels[id]
    }))
  const base = {
    id,
    type: question.type,
    labelledAttempts: labelled.length,
    unlabelledAttempts: pairs.length - labelled.length,
    scored: scored.length,
    unavailable: labelled.length - scored.length,
    smallSample: scored.length < 50,
    // Closed answers/labels only; never include source text or subject identifiers here.
    rawPairs: scored.length < 50 ? scored : null
  }
  if (question.type === 'noul') {
    const binary = scored.map(({ answer, label }) => [answer.noul, label])
    return {
      ...base,
      brier: mean(binary.map(([p, y]) => (p - y) ** 2)),
      bands: reliabilityBands(binary)
    }
  }
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria)
    const correct = scored.filter(({ answer, label }) => answer.choice === label).length
    return {
      ...base,
      accuracy: scored.length ? correct / scored.length : null,
      accuracyWilson95: wilsonInterval(correct, scored.length),
      multiclassBrier: mean(
        scored.map(({ answer, label }) =>
          options.reduce(
            (sum, option) => sum + (answer.probabilities[option] - Number(label === option)) ** 2,
            0
          )
        )
      ),
      selectedProbabilityBands: reliabilityBands(
        scored.map(({ answer, label }) => [
          answer.probabilities[answer.choice],
          Number(answer.choice === label)
        ])
      ),
      options: options.map((option) => ({
        option,
        bands: reliabilityBands(
          scored.map(({ answer, label }) => [
            answer.probabilities[option],
            Number(label === option)
          ])
        )
      }))
    }
  }
  return {
    ...base,
    meanAbsoluteError: mean(scored.map(({ answer, label }) => Math.abs(answer.score - label))),
    rankedProbabilityScore: mean(
      scored.map(({ answer, label }) => rankedProbabilityScore(answer, label))
    ),
    scale: 'ordinal; not a probability or physical quantity'
  }
}

function dispositionCalibration(pairs) {
  const complete = pairs.filter(
    ({ observation, outcome }) =>
      observation.status === 'success' &&
      Object.values(outcome.labels).every((label) => label !== null)
  )
  const advisory = complete.filter(({ observation }) => observation.disposition === 'advisory')
  const incorrect = advisory.filter(
    ({ observation, outcome }) =>
      !recipeLabelMetrics(observation, outcome).every((metric) => metric.correct)
  ).length
  return {
    policyEvidence: 'legacy thresholds; not independently calibrated for this cohort',
    fullyLabelledSuccessful: complete.length,
    advisoryLabelled: advisory.length,
    advisoryIncorrect: incorrect,
    conditionalAdvisoryErrorRate: advisory.length ? incorrect / advisory.length : null,
    errorRateWilson95: wilsonInterval(incorrect, advisory.length),
    reviewedLabelled: complete.length - advisory.length
  }
}

function outcomeSlice(recipe, pairs, method) {
  const labelled = pairs.filter(({ outcome }) => outcome.provenance?.method === method)
  const observations = labelled.map(({ observation }) => observation)
  return {
    method,
    evidence:
      method === 'model_reference'
        ? 'model agreement only; not independent accuracy'
        : 'operator-attested labels; independence not authenticated',
    labelledAttempts: labelled.length,
    questions: Object.entries(recipe.questions).map(([id, question]) =>
      questionCalibration(question, id, labelled)
    ),
    comparison: summarizeRecipePairs(
      observations,
      labelled.map(({ outcome }) => outcome)
    ),
    disposition: dispositionCalibration(labelled)
  }
}

function cohortReport(identity, rows, outcomeById) {
  const recipe = getDecisionRecipe(identity.recipeId, identity.recipeVersion)
  const pairs = rows
    .filter((row) => outcomeById.has(row.observationId))
    .map((observation) => ({ observation, outcome: outcomeById.get(observation.observationId) }))
  const reasons = {}
  for (const row of rows.filter((row) => row.status !== 'success')) {
    const reason = row.decisionRecord?.reason ?? 'legacy_unknown'
    reasons[reason] = (reasons[reason] ?? 0) + 1
  }
  const independent = pairs.filter(({ outcome }) =>
    ['human_attested', 'verified_record'].includes(outcome.provenance?.method)
  )
  return {
    ...identity,
    requestedModelSource: identity.hasDecisionRecord ? 'recorded' : 'inferred_from_recipe_version',
    ...summarizeRecipePairs(
      rows,
      independent.map(({ outcome }) => outcome)
    ),
    unavailable: rows.filter((row) => row.status !== 'success').length,
    unavailableReasons: reasons,
    returnedModels: [
      ...new Set(rows.filter((row) => row.status === 'success').map((row) => row.model))
    ],
    distinctSubjects: identity.hasDecisionRecord
      ? new Set(rows.map((row) => row.decisionRecord.context.subjectId)).size
      : null,
    repeatedSubjectInputs: identity.hasDecisionRecord
      ? rows.length -
        new Set(
          rows.map(
            (row) => `${row.decisionRecord.context.subjectId}:${row.decisionRecord.inputDigest}`
          )
        ).size
      : null,
    unlabelled: rows.length - pairs.length,
    labelsWithoutProvenance: pairs.filter(({ outcome }) => !outcome.provenance).length,
    attestedIndependentLabels: independent.length,
    modelReferenceLabels: pairs.filter(
      ({ outcome }) => outcome.provenance?.method === 'model_reference'
    ).length,
    outcomes: ['human_attested', 'verified_record', 'model_reference'].map((method) =>
      outcomeSlice(recipe, pairs, method)
    )
  }
}

export function decisionRecordCalibration(records, validateResult) {
  const { observations, outcomes } = validateDecisionRecordLedger(records, validateResult)
  const outcomeById = new Map(outcomes.map((row) => [row.observationId, row]))
  const groups = new Map()
  for (const observation of observations) {
    const recipe = getDecisionRecipe(observation.recipeId, observation.recipeVersion)
    const record = observation.decisionRecord
    const identity = {
      recipeId: observation.recipeId,
      recipeVersion: observation.recipeVersion,
      questionHash: observation.questionHash,
      requestedModel: record?.requestedModel ?? recipe.model,
      policyVersion: record?.policyVersion ?? recipe.policyVersion,
      hasDecisionRecord: Boolean(record),
      recordSchemaVersion: record?.version ?? null,
      surface: record?.context.surface ?? 'legacy_unspecified',
      scopeId: record?.context.scopeId ?? null
    }
    const key = JSON.stringify(identity)
    if (!groups.has(key)) {
      groups.set(key, { identity, rows: [] })
    }
    groups.get(key).rows.push(observation)
  }
  return {
    schemaVersion: 1,
    kind: 'decision_calibration',
    generatedAt: new Date().toISOString(),
    authority: 'advisory-only',
    deploymentVerdict: 'inconclusive',
    limitations: [
      'No automatic threshold fitting, activation or approval; disposition thresholds remain uncalibrated.',
      'Label provenance is operator-attested; independence and blinding are not authenticated.',
      'Legacy labels without provenance are excluded from calibration; model references are separate.',
      'Unavailable answers are missing predictions; complete-case service comparisons count them as unsuccessful, never as negative labels.',
      'Partial labels exclude the case from paired quality and disposition comparisons, not per-question metrics.',
      'Correlated/selected samples invalidate population or causal claims; Wilson intervals describe label counts under an independence assumption.',
      'Small-sample threshold 50 only controls diagnostic display; it is not an activation gate.',
      'Keep this per-host CLI five-second/no-retry ledger separate from other transport cohorts.'
    ],
    cohorts: [...groups.values()].map(({ identity, rows }) =>
      cohortReport(identity, rows, outcomeById)
    )
  }
}
