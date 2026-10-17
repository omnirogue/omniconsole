import { createHash } from 'node:crypto'
import { buildRecipeRequest } from './decision-recipes.mjs'
import { getDecisionRecipe } from './decision-recipe-registry.mjs'
import {
  validateRecipeOutcome,
  validateRecipeLedger,
  validateOutcomeProvenance
} from './decision-recipe-outcomes.mjs'

export const exactKeys = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))
export const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isId = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
export const recordDigest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const recordCommands = ['registry', 'decide-record', 'record-outcome', 'calibration']
// Retain each schema when adding a version; historical rows never use the newest schema implicitly.
const schemas = new Map([[1, { surfaces: ['manual_review'] }]])

export function requireDecisionRecordFlag(environment) {
  if (environment.JEV_DECISION_RECORDS_ENABLED !== '1') {
    throw new Error('decision_records_disabled')
  }
}
export function inferenceDisabled(environment) {
  return ['JEV_DECISIONS_DISABLED', 'OMNI_STRUCTURED_DECISIONS_KILL'].some(
    (key) => environment[key] && !['0', 'false'].includes(environment[key].toLowerCase())
  )
}

export function validateDecisionContext(value, recipe, schemaVersion = 1) {
  const schema = schemas.get(schemaVersion)
  if (
    !schema ||
    !recipe ||
    !exactKeys(value, ['surface', 'scopeId', 'subjectId', 'sourceRevision', 'checks']) ||
    !schema.surfaces.includes(value.surface) ||
    !isId(value.scopeId) ||
    !isId(value.subjectId) ||
    !isDigest(value.sourceRevision) ||
    !Array.isArray(value.checks) ||
    value.checks.length !== recipe.admissionGates.length ||
    new Set(value.checks.map((check) => check?.id)).size !== recipe.admissionGates.length ||
    value.checks.some(
      (check) =>
        !exactKeys(check, ['id', 'status', 'evidenceDigest']) ||
        !recipe.admissionGates.includes(check.id) ||
        !['pass', 'fail', 'unknown'].includes(check.status) ||
        (check.evidenceDigest !== null && !isDigest(check.evidenceDigest)) ||
        (check.status === 'pass' && check.evidenceDigest === null)
    )
  ) {
    throw new Error('invalid_decision_context')
  }
  return structuredClone(value)
}

export function validateDecisionPacket(input) {
  if (!exactKeys(input, ['recipeId', 'recipeVersion', 'state', 'context'])) {
    throw new Error('invalid_decision_packet')
  }
  const recipe = getDecisionRecipe(input.recipeId, input.recipeVersion)
  if (!recipe || input.recipeVersion !== recipe.version) {
    throw new Error('unsupported_recipe_version')
  }
  const request = buildRecipeRequest(input.recipeId, input.state, input.recipeVersion)
  return {
    ...structuredClone(input),
    state: request.state,
    context: validateDecisionContext(input.context, recipe)
  }
}

export async function evaluateDecisionRecord(input, dependencies, environment = process.env) {
  requireDecisionRecordFlag(environment)
  const packet = validateDecisionPacket(input)
  const recipe = getDecisionRecipe(packet.recipeId, packet.recipeVersion)
  const reason = inferenceDisabled(environment)
    ? 'disabled'
    : packet.context.checks.some((check) => check.status !== 'pass')
      ? 'attested_gate'
      : null
  let result = reason
    ? {
        status: 'unavailable',
        disposition: 'review',
        elapsedMs: 0,
        answers: {},
        actions: [],
        authority: 'advisory-only'
      }
    : await dependencies.evaluate(packet.recipeId, packet.state, packet.recipeVersion)
  if (inferenceDisabled(environment)) {
    result = {
      status: 'unavailable',
      disposition: 'review',
      elapsedMs: result.elapsedMs,
      answers: {},
      actions: [],
      authority: 'advisory-only'
    }
  }
  const observation = dependencies.measure(packet.recipeId, result, undefined, packet.recipeVersion)
  if (observation.recipeVersion !== packet.recipeVersion) {
    throw new Error('recipe_version_mismatch')
  }
  observation.decisionRecord = {
    version: 1,
    policyVersion: recipe.policyVersion,
    context: packet.context,
    inputDigest: recordDigest({ recipeId: packet.recipeId, state: packet.state }),
    requestedModel: recipe.model,
    actualModel: result.status === 'success' ? result.model : null,
    reason:
      (inferenceDisabled(environment) ? 'disabled' : reason) ??
      (result.status === 'success' ? null : 'provider_unavailable')
  }
  return observation
}

export function validateIndependentOutcome(input, observation) {
  if (!exactKeys(input, ['outcome', 'provenance'])) {
    throw new Error('invalid_outcome_provenance')
  }
  const outcome = validateRecipeOutcome(input.outcome, observation, { partial: true })
  validateOutcomeProvenance(input.provenance, observation, outcome.source)
  return { ...outcome, provenance: structuredClone(input.provenance) }
}

export function validateDecisionRecordLedger(records, validateResult) {
  const ledger = validateRecipeLedger(records)
  for (const row of ledger.observations) {
    const recipe = getDecisionRecipe(row.recipeId, row.recipeVersion)
    if (row.status === 'success') {
      const request = buildRecipeRequest(
        row.recipeId,
        Object.fromEntries(recipe.fields.map((field) => [field, ''])),
        row.recipeVersion
      )
      validateResult(
        {
          provider: 'typesafe',
          model: row.model,
          answers: row.answers,
          usage: row.usage,
          ...(row.requestId ? { requestId: row.requestId } : {})
        },
        request
      )
    }
    if (row.decisionRecord !== undefined) {
      const record = row.decisionRecord
      if (
        !exactKeys(record, [
          'version',
          'policyVersion',
          'context',
          'inputDigest',
          'requestedModel',
          'actualModel',
          'reason'
        ]) ||
        !schemas.has(record.version) ||
        record.policyVersion !== recipe.policyVersion ||
        !isDigest(record.inputDigest) ||
        record.requestedModel !== recipe.model ||
        record.actualModel !== (row.status === 'success' ? row.model : null) ||
        (row.status === 'success'
          ? record.reason !== null
          : !['disabled', 'attested_gate', 'provider_unavailable'].includes(record.reason))
      ) {
        throw new Error('invalid_decision_record')
      }
      validateDecisionContext(record.context, recipe, record.version)
      const failedGate = record.context.checks.some((check) => check.status !== 'pass')
      if (
        (row.status === 'success' && failedGate) ||
        (record.reason === 'attested_gate' && !failedGate)
      ) {
        throw new Error('conflicting_attested_gate')
      }
    }
  }
  return ledger
}
