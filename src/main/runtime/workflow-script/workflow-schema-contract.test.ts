import { describe, expect, it } from 'vitest'
import { assertWorkflowSchemaContract } from './workflow-schema-contract'
import answer from './presets/schemas/answer.schema.json'
import ballot from './presets/schemas/council-review.schema.json'
import synthesis from './presets/schemas/council-synthesis.schema.json'
import findings from './presets/schemas/findings.schema.json'
import refutation from './presets/schemas/refutation.schema.json'
import ranking from './presets/schemas/discovery-ranking.schema.json'
import areasV7 from './presets/schemas/discovery-areas-v7.schema.json'
import findingsV7 from './presets/schemas/findings-v7.schema.json'
import verdictV7 from './presets/schemas/verdict-v7.schema.json'
import verdictFilesV7 from './presets/schemas/verdict-files-v7.schema.json'
import reportV7 from './presets/schemas/discovery-report-v7.schema.json'
import repeatsV7 from './presets/schemas/discovery-repeats-v7.schema.json'

const wrap = (schema: unknown) => ({
  type: 'object',
  properties: { answer: schema },
  required: ['answer']
})
describe('workflow schema registration contract', () => {
  it.each([
    answer,
    ballot,
    synthesis,
    findings,
    refutation,
    ranking,
    areasV7,
    findingsV7,
    verdictV7,
    verdictFilesV7,
    reportV7,
    repeatsV7
  ])('accepts bundled preset schemas', (schema) => {
    expect(() => assertWorkflowSchemaContract(schema)).not.toThrow()
  })
  it.each([
    { type: 'string', format: 'email' },
    { type: 'array', uniqueItems: true },
    { $ref: '#/definitions/unvalidated' },
    { type: 'string', pattern: '[' },
    { type: 'string', minLength: -1 },
    { type: 'string', minLength: 4, maxLength: 2 },
    { enum: [{ nested: 'object' }] },
    { type: 'unknown' },
    { oneOf: [] },
    { required: ['missing'], properties: {} }
  ])('rejects unenforceable or malformed constraints before execution', (schema) => {
    expect(() => assertWorkflowSchemaContract(wrap(schema))).toThrow()
  })
  it('rejects cyclic schemas without overflowing the host stack', () => {
    const schema: Record<string, unknown> = { type: 'object', properties: {} }
    schema.items = schema
    expect(() => assertWorkflowSchemaContract(schema)).toThrow('unbounded')
  })
})
