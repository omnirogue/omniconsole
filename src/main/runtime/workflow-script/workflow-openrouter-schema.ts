import type { JsonSchema } from '../../../shared/json-schema-validate'
import { workflowOriginalValue, workflowStrictSchema } from './workflow-strict-schema'

/** OpenRouter-only grammar workaround; the host still validates the original schema. */
export function openRouterStrictSchema(schema: JsonSchema): JsonSchema {
  return workflowStrictSchema(schema, true)
}

export const openRouterOriginalValue = workflowOriginalValue
