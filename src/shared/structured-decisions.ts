import { assertJsonTextStructureWithinLimits } from './json-text-structure-limit'
import {
  DECISION_MAX_INPUT_BYTES,
  DecisionProviderError,
  decisionRequestSchema,
  type DecisionRequest
} from './structured-decision-contract'

export * from './structured-decision-contract'
export { validateDecisionResult } from './structured-decision-results'

// Bound traversal before serialization; this also rejects cycles, getters, and non-JSON objects.
function checkJsonBudget(
  value: unknown,
  depth = 0,
  budget = { remaining: DECISION_MAX_INPUT_BYTES }
): void {
  if (depth > 24 || --budget.remaining < 0) {
    throw new DecisionProviderError('input_too_large')
  }
  if (typeof value === 'string') {
    budget.remaining -= value.length
    if (budget.remaining < 0) {
      throw new DecisionProviderError('input_too_large')
    }
    return
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (
    typeof value !== 'object' ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new DecisionProviderError('invalid_request')
  }
  if (Array.isArray(value) && value.length > budget.remaining) {
    throw new DecisionProviderError('input_too_large')
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') {
      continue
    }
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new DecisionProviderError('invalid_request')
    }
    if (depth === 0 && descriptor.value === undefined) {
      continue
    }
    budget.remaining -= key.length
    checkJsonBudget(descriptor.value, depth + 1, budget)
  }
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== 'object') {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    freezeJson(child)
  }
}

export function snapshotDecisionRequest(input: DecisionRequest): DecisionRequest {
  try {
    checkJsonBudget(input)
    const text = JSON.stringify(input)
    if (new TextEncoder().encode(text).byteLength > DECISION_MAX_INPUT_BYTES) {
      throw new DecisionProviderError('input_too_large')
    }
    assertJsonTextStructureWithinLimits(text, { nestingDepth: 24, structuralTokens: 20_000 })
    const parsed = decisionRequestSchema.safeParse(JSON.parse(text))
    if (!parsed.success) {
      throw new DecisionProviderError('invalid_request')
    }
    freezeJson(parsed.data)
    return parsed.data
  } catch (error) {
    throw error instanceof DecisionProviderError
      ? error
      : new DecisionProviderError('invalid_request')
  }
}
