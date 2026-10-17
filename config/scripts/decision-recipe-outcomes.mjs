import { validateQueueObservation, validateQueueHumanChoice } from './decision-queue-validators.mjs'
import { DECISION_RECIPES, recipeDisposition } from './decision-recipes.mjs'
import { getDecisionRecipe, recipeQuestionHash } from './decision-recipe-registry.mjs'

const finiteNonnegative = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const uuid = (value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

export function validateRecipeOutcome(outcome, observation, { partial = false } = {}) {
  const keys = [
    'observationId',
    'labels',
    'baselineElapsedMs',
    'baselineCorrect',
    'workflowElapsedMs',
    'baselineWorkflowElapsedMs',
    'source'
  ]
  const sources = partial
    ? ['human', 'verified_outcome', 'model_reference']
    : ['human', 'verified_outcome']
  if (
    !exact(outcome, keys) ||
    !uuid(outcome.observationId) ||
    outcome.observationId !== observation.observationId ||
    !sources.includes(outcome.source)
  ) {
    throw new Error('invalid_outcome')
  }
  for (const key of ['baselineElapsedMs', 'workflowElapsedMs', 'baselineWorkflowElapsedMs']) {
    if (outcome[key] !== null && !finiteNonnegative(outcome[key])) {
      throw new Error('invalid_timing')
    }
  }
  if (outcome.baselineCorrect !== null && typeof outcome.baselineCorrect !== 'boolean') {
    throw new Error('invalid_baseline')
  }
  const questions = getDecisionRecipe(observation.recipeId, observation.recipeVersion)?.questions
  if (!questions || !exact(outcome.labels, Object.keys(questions))) {
    throw new Error('invalid_labels')
  }
  for (const [id, question] of Object.entries(questions)) {
    const value = outcome.labels[id]
    if (partial && value === null) {
      continue
    }
    if (
      question.type === 'choice'
        ? typeof value !== 'string' || !Object.hasOwn(question.criteria, value)
        : question.type === 'noul'
          ? value !== 0 && value !== 1
          : !finiteNonnegative(value) ||
            value > question.criteria.length - 1 ||
            (partial && !Number.isInteger(value))
    ) {
      throw new Error('invalid_label')
    }
  }
  return { schemaVersion: 1, kind: 'outcome', recordedAt: new Date().toISOString(), ...outcome }
}

export function validateOutcomeProvenance(provenance, observation, source) {
  const methods = {
    human_attested: 'human',
    verified_record: 'verified_outcome',
    model_reference: 'model_reference'
  }
  const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  if (
    !exact(provenance, ['method', 'evidenceDigest', 'inputDigest']) ||
    !Object.hasOwn(methods, provenance.method) ||
    methods[provenance.method] !== source ||
    !digest(provenance.evidenceDigest) ||
    !digest(provenance.inputDigest) ||
    !observation.decisionRecord ||
    provenance.inputDigest !== observation.decisionRecord.inputDigest
  ) {
    throw new Error('invalid_outcome_provenance')
  }
}

export const recipeMean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.floor(sorted.length / 2)
  return sorted.length ? (sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2) : null
}

export function recipeLabelMetrics(observation, outcome) {
  const recipe = getDecisionRecipe(observation.recipeId, observation.recipeVersion)
  return Object.entries(recipe.questions).map(([id, question]) => {
    const value = observation.answers[id]?.[question.type]
    const expected = outcome.labels[id]
    const labelled = expected !== null
    const present = labelled && observation.status === 'success' && value !== undefined
    return {
      type: question.type,
      labelled,
      correct:
        present &&
        (question.type === 'choice'
          ? value === expected
          : question.type === 'noul'
            ? Number(value >= 0.5) === expected
            : Math.abs(value - expected) <= 0.6),
      error: present && question.type === 'score' ? Math.abs(value - expected) : null,
      brier: present && question.type === 'noul' ? (value - expected) ** 2 : null
    }
  })
}

export function summarizeRecipePairs(rows, paired) {
  const byId = new Map(rows.map((row) => [row.observationId, row]))
  const quality = paired.map((outcome) => {
    const scored = recipeLabelMetrics(byId.get(outcome.observationId), outcome)
    return {
      complete: scored.every((row) => row.labelled),
      correct: scored.every((row) => row.correct),
      baseline: outcome.baselineCorrect,
      scored
    }
  })
  const timingPairs = paired.filter(
    (row) => row.baselineElapsedMs !== null && byId.get(row.observationId).status === 'success'
  )
  const qualityPairs = quality.filter((row) => row.complete && row.baseline !== null)
  const workflowPairs = paired.filter(
    (row) => row.workflowElapsedMs !== null && row.baselineWorkflowElapsedMs !== null
  )
  return {
    attempted: rows.length,
    successful: rows.filter((row) => row.status === 'success').length,
    review: rows.filter((row) => row.disposition === 'review').length,
    latencyAllAttemptsMedianMs: median(rows.map((row) => row.elapsedMs)),
    labelled: quality.filter((row) => row.complete).length,
    partiallyLabelled: quality.filter((row) => !row.complete).length,
    correct: quality.filter((row) => row.correct).length,
    scoreMeanAbsoluteError: recipeMean(
      quality.flatMap((row) =>
        row.scored.map((value) => value.error).filter((value) => value !== null)
      )
    ),
    noulBrier: recipeMean(
      quality.flatMap((row) =>
        row.scored.map((value) => value.brier).filter((value) => value !== null)
      )
    ),
    pairedLatencyCount: timingPairs.length,
    pairedMeanLatencySavedMs: recipeMean(
      timingPairs.map((row) => row.baselineElapsedMs - byId.get(row.observationId).elapsedMs)
    ),
    slowerLatencyCount: timingPairs.filter(
      (row) => row.baselineElapsedMs < byId.get(row.observationId).elapsedMs
    ).length,
    pairedQualityCount: qualityPairs.length,
    pairedAccuracyDelta: recipeMean(
      qualityPairs.map((row) => Number(row.correct) - Number(row.baseline))
    ),
    pairedWorkflowCount: workflowPairs.length,
    meanWorkflowSavedMs: recipeMean(
      workflowPairs.map((row) => row.baselineWorkflowElapsedMs - row.workflowElapsedMs)
    ),
    slowerWorkflowCount: workflowPairs.filter(
      (row) => row.workflowElapsedMs > row.baselineWorkflowElapsedMs
    ).length
  }
}

export function validateRecipeLedger(records) {
  if (
    !Array.isArray(records) ||
    records.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
  ) {
    throw new Error('invalid_ledger')
  }
  const observations = records.filter((row) => row.kind === undefined)
  const outcomes = records.filter((row) => row.kind === 'outcome')
  const humanChoices = records.filter((row) => row.kind === 'human_choice')
  if (observations.length + outcomes.length + humanChoices.length !== records.length) {
    throw new Error('unknown_ledger_record')
  }
  for (const row of observations) {
    if (row.queueTriage !== undefined) {
      validateQueueObservation(row)
    }
    const recipe = getDecisionRecipe(row.recipeId, row.recipeVersion)
    if (
      !recipe ||
      !uuid(row.observationId) ||
      row.schemaVersion !== 1 ||
      row.recipeVersion !== recipe.version ||
      row.questionHash !== recipeQuestionHash(recipe) ||
      !finiteNonnegative(row.elapsedMs) ||
      !['success', 'unavailable'].includes(row.status) ||
      row.authority !== 'advisory-only' ||
      !Array.isArray(row.actions) ||
      row.actions.length !== 0 ||
      (row.status === 'success' &&
        (row.model !== recipe.model ||
          !['advisory', 'review'].includes(row.disposition) ||
          row.disposition !== recipeDisposition(row.recipeId, row.answers, row.recipeVersion))) ||
      (row.status === 'unavailable' &&
        (row.disposition !== 'review' || !row.answers || Object.keys(row.answers).length !== 0))
    ) {
      throw new Error('invalid_or_incompatible_observation')
    }
  }
  if (
    new Set(observations.map((row) => row.observationId)).size !== observations.length ||
    new Set(outcomes.map((row) => row.observationId)).size !== outcomes.length
  ) {
    throw new Error('duplicate_observation_or_outcome')
  }
  const byId = new Map(observations.map((row) => [row.observationId, row]))
  for (const row of outcomes) {
    const observation = byId.get(row.observationId)
    if (!observation) {
      throw new Error('orphan_outcome')
    }
    const { kind: _kind, schemaVersion, recordedAt: _date, provenance, ...input } = row
    if (schemaVersion !== 1) {
      throw new Error('invalid_outcome')
    }
    validateRecipeOutcome(input, observation, { partial: provenance !== undefined })
    if (provenance !== undefined) {
      validateOutcomeProvenance(provenance, observation, input.source)
    }
  }
  if (new Set(humanChoices.map((row) => row.observationId)).size !== humanChoices.length) {
    throw new Error('duplicate_human_choice')
  }
  for (const row of humanChoices) {
    validateQueueHumanChoice(row, byId.get(row.observationId))
  }
  return { observations, outcomes, byId, ...(humanChoices.length ? { humanChoices } : {}) }
}

export function summarizeRecipeLedger(records) {
  const { observations, outcomes, byId } = validateRecipeLedger(records)
  const cohorts = new Map(
    Object.keys(DECISION_RECIPES).map((recipeId) => [
      `${recipeId}@1`,
      { recipeId, recipeVersion: 1 }
    ])
  )
  for (const row of observations) {
    cohorts.set(`${row.recipeId}@${row.recipeVersion}`, {
      recipeId: row.recipeId,
      recipeVersion: row.recipeVersion
    })
  }
  return [...cohorts.values()].map(({ recipeId, recipeVersion }) => {
    const rows = observations.filter(
      (row) => row.recipeId === recipeId && row.recipeVersion === recipeVersion
    )
    const paired = outcomes.filter((row) => {
      const observation = byId.get(row.observationId)
      return observation.recipeId === recipeId && observation.recipeVersion === recipeVersion
    })
    return {
      recipeId,
      recipeVersion,
      modelReferenceLabels: paired.filter((row) => row.source === 'model_reference').length,
      ...summarizeRecipePairs(
        rows,
        paired.filter((row) => row.source !== 'model_reference')
      )
    }
  })
}
