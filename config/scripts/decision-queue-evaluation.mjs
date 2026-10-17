import { evaluateRecipe, recipeMeasurement } from './run-decision-recipe.mjs'
import { recordDigest } from './decision-record-contract.mjs'
import { validateRecipeLedger } from './decision-recipe-outcomes.mjs'
import { withDecisionLedger } from './decision-record-ledger.mjs'
import { queueTriageEnabled } from './decision-queue-configuration.mjs'

export const queueText = (value) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 2048
export const unavailableQueueResult = () => ({
  status: 'unavailable',
  disposition: 'review',
  elapsedMs: 0,
  answers: {},
  actions: [],
  authority: 'advisory-only'
})
export async function evaluateQueueRecipe(recipeId, state, options, timeoutMs) {
  if (!queueTriageEnabled(options.environment)) {
    return unavailableQueueResult()
  }
  try {
    return await evaluateRecipe({
      recipeId,
      state,
      provider: options.provider,
      environment: options.environment,
      timeoutMs
    })
  } catch {
    return unavailableQueueResult()
  }
}
export async function persistQueueObservation(recipeId, result, input, context, options) {
  if (!queueTriageEnabled(options.environment)) {
    return null
  }
  const row = recipeMeasurement(recipeId, result)
  row.queueTriage = { version: 1, inputDigest: recordDigest(input), ...context }
  await withDecisionLedger(options.ledgerPath, (rows) => {
    if (!queueTriageEnabled(options.environment)) {
      throw new Error('queue_triage_disabled')
    }
    validateRecipeLedger([...rows, row])
    return row
  })
  return row.observationId
}
export function queueDeadline(options) {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error('invalid_timeout')
  }
  const end = performance.now() + timeoutMs
  return () => Math.max(0, Math.floor(end - performance.now()))
}
