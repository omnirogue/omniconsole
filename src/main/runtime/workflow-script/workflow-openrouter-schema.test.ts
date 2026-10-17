import { describe, expect, it } from 'vitest'
import { validateJsonSchema, type JsonSchema } from '../../../shared/json-schema-validate'
import { AUDIT_READER_SCHEMA } from '../../../shared/workflow-audit-contracts'
import { openRouterStrictSchema } from './workflow-openrouter-schema'

describe('OpenRouter provider schema projection', () => {
  it('omits only the non-whitespace advisory pattern recursively without changing the source schema', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        summary: { type: 'string', minLength: 1, pattern: '\\S' },
        code: { type: 'string', pattern: '^[A-Z]+$' },
        labels: { type: 'array', items: { type: 'string', pattern: '\\S' } }
      },
      required: ['summary', 'code', 'labels'],
      additionalProperties: false
    }
    const original = structuredClone(schema)

    const projected = openRouterStrictSchema(schema)

    expect(projected.properties?.summary).toEqual({ type: 'string', minLength: 1 })
    expect(projected.properties?.code?.pattern).toBe('^[A-Z]+$')
    expect(projected.properties?.labels?.items?.pattern).toBeUndefined()
    expect(schema).toEqual(original)
  })

  it('retains host-side non-whitespace validation for multi-character audit identifiers', () => {
    const reader = {
      version: 1,
      chunkId: 'chunk-0001',
      sourceIds: ['source-01'],
      findings: []
    }
    const projected = openRouterStrictSchema(AUDIT_READER_SCHEMA)

    expect(projected.properties?.chunkId?.pattern).toBeUndefined()
    expect(projected.properties?.sourceIds?.items?.pattern).toBeUndefined()
    expect(validateJsonSchema(AUDIT_READER_SCHEMA, reader)).toEqual([])
    expect(validateJsonSchema(AUDIT_READER_SCHEMA, { ...reader, sourceIds: ['   '] })).not.toEqual(
      []
    )
  })
})
