import {
  describeJsonSchemaProblems,
  validateJsonSchema,
  type JsonSchema
} from '../../../../shared/json-schema-validate'
import type { GraphJevStore } from '../graph/graph-jev-store'

/** A present record is immutable execution evidence, never permission to rerun a missing fact. */
export function readAuditCacheRecord(
  store: GraphJevStore,
  id: string,
  digest: string
): { value: unknown } | undefined {
  if (store.damaged()) {
    throw new Error('Audit cache record is damaged')
  }
  const record = store.read(id)
  if (record === undefined) {
    return undefined
  }
  const schema: JsonSchema = {
    type: 'object',
    required: ['digest', 'outcome', 'at'],
    additionalProperties: false,
    properties: {
      digest: { type: 'string', const: digest },
      at: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      outcome: {
        type: 'object',
        required: ['value'],
        additionalProperties: false,
        properties: { value: {} }
      }
    }
  }
  const problems = validateJsonSchema(schema, record)
  if (problems.length) {
    throw new Error(`Invalid audit cache record ${id}: ${describeJsonSchemaProblems(problems)}`)
  }
  return record.outcome as { value: unknown }
}
