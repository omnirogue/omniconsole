import { describe, expect, it } from 'vitest'
import {
  describeJsonSchemaProblems,
  unusableAgentSchemaReason,
  validateJsonSchema,
  type JsonSchema
} from './json-schema-validate'

const FINDINGS: JsonSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', minLength: 1 },
          line: { type: 'integer', minimum: 1 },
          severity: { type: 'string', enum: ['low', 'high'] }
        },
        required: ['file', 'severity'],
        additionalProperties: false
      }
    },
    refuted: { type: 'boolean' }
  },
  required: ['findings']
}

describe('validateJsonSchema', () => {
  it('accepts a conforming value', () => {
    expect(
      validateJsonSchema(FINDINGS, {
        findings: [{ file: 'a.ts', line: 3, severity: 'high' }],
        refuted: false
      })
    ).toEqual([])
  })

  it('names every defect with its path', () => {
    const problems = validateJsonSchema(FINDINGS, {
      findings: [{ file: '', line: 0, severity: 'medium', extra: 1 }, 'x']
    })
    expect(describeJsonSchemaProblems(problems)).toBe(
      'findings[0].file: expected at least 1 characters; findings[0].line: expected at least 1; findings[0].severity: expected one of low, high; findings[0].extra: is not allowed; findings[1]: expected object, got string'
    )
  })

  it('reports a missing required field and a wrong root type', () => {
    expect(validateJsonSchema(FINDINGS, {})).toEqual([{ path: 'findings', message: 'is required' }])
    expect(validateJsonSchema(FINDINGS, 'prose')).toEqual([
      { path: '', message: 'expected object, got string' }
    ])
  })

  it('treats integers as numbers, honours type unions, patterns and alternatives', () => {
    expect(validateJsonSchema({ type: 'number' }, 3)).toEqual([])
    expect(validateJsonSchema({ type: 'integer' }, 3.5)).toHaveLength(1)
    expect(validateJsonSchema({ type: ['string', 'null'] }, null)).toEqual([])
    expect(validateJsonSchema({ type: 'string', pattern: '^[a-z]+$' }, 'AB')).toHaveLength(1)
    expect(validateJsonSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] }, 'x')).toEqual([])
    expect(
      validateJsonSchema({ oneOf: [{ type: 'string' }, { type: 'string' }] }, 'x')
    ).toHaveLength(1)
  })
})

describe('unusableAgentSchemaReason', () => {
  it('requires an object root with properties and a required list drawn from them', () => {
    expect(unusableAgentSchemaReason(FINDINGS)).toBeNull()
    expect(unusableAgentSchemaReason({ type: 'array' })).toContain("type 'object'")
    expect(unusableAgentSchemaReason({ type: 'object' })).toContain('properties')
    expect(
      unusableAgentSchemaReason({ type: 'object', properties: { a: {} }, required: ['b'] })
    ).toContain('b')
    expect(unusableAgentSchemaReason(null)).toContain('object')
  })
})
