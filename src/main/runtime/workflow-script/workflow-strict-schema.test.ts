import { describe, expect, it } from 'vitest'
import { validateJsonSchema } from '../../../shared/json-schema-validate'
import { workflowOriginalValue, workflowStrictSchema } from './workflow-strict-schema'

describe('strict provider workflow schema projection', () => {
  it('requires optional fields as nullable while preserving the host pattern by default', () => {
    const schema = {
      type: 'object',
      properties: { optional: { type: 'string', pattern: '\\S' } },
      required: [],
      additionalProperties: false
    }

    expect(workflowStrictSchema(schema)).toEqual({
      type: 'object',
      properties: {
        optional: {
          anyOf: [{ type: 'string', pattern: '\\S' }, { type: 'null' }]
        }
      },
      required: ['optional'],
      additionalProperties: false
    })
    expect(workflowStrictSchema(schema, true).properties?.optional).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }]
    })
  })

  it('omits projection nulls but preserves nulls allowed by the original optional schema', () => {
    const schema = {
      type: 'object',
      properties: {
        omitted: { type: 'string' },
        enumNull: { enum: ['ready', null] },
        constNull: { const: null },
        unionNull: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        required: { type: 'string' }
      },
      required: ['required'],
      additionalProperties: false
    }
    const result = workflowOriginalValue(schema, {
      omitted: null,
      enumNull: null,
      constNull: null,
      unionNull: null,
      required: null
    })

    expect(result).toEqual({
      enumNull: null,
      constNull: null,
      unionNull: null,
      required: null
    })
    expect(validateJsonSchema(schema, result)).not.toEqual([])
    expect(
      validateJsonSchema(schema, {
        required: 'ok',
        enumNull: null,
        constNull: null,
        unionNull: null
      })
    ).toEqual([])
  })
})
