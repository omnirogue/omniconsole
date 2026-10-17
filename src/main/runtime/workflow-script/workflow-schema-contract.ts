import { unusableAgentSchemaReason } from '../../../shared/json-schema-validate'

const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'oneOf',
  'description'
])
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isScalar = (value: unknown) =>
  value === null ||
  ['string', 'boolean'].includes(typeof value) ||
  (typeof value === 'number' && Number.isFinite(value))

/** Fail before admission for keywords the shared result validator cannot enforce. */
export function assertWorkflowSchemaContract(schema: unknown): void {
  if (!isObject(schema)) {
    throw new Error('Workflow schema must be an object')
  }
  const active = new Set<object>()
  let nodes = 0
  const visit = (node: unknown, path: string, depth: number): void => {
    if (!isObject(node) || depth > 32 || ++nodes > 4096 || active.has(node)) {
      throw new Error(`Invalid or unbounded workflow schema at ${path}`)
    }
    active.add(node)
    for (const key of Object.keys(node)) {
      if (!keywords.has(key)) {
        throw new Error(`Unsupported workflow schema keyword ${path}.${key}`)
      }
    }
    if (node.type !== undefined) {
      const values = Array.isArray(node.type) ? node.type : [node.type]
      if (
        !values.length ||
        values.some((value) => typeof value !== 'string' || !types.has(value))
      ) {
        throw new Error(`Invalid schema type at ${path}`)
      }
    }
    if (node.properties !== undefined) {
      if (!isObject(node.properties)) {
        throw new Error(`Invalid properties at ${path}`)
      }
      for (const [key, value] of Object.entries(node.properties)) {
        visit(value, `${path}.${key}`, depth + 1)
      }
    }
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) ||
        node.required.some(
          (key) =>
            typeof key !== 'string' ||
            !isObject(node.properties) ||
            !Object.hasOwn(node.properties, key)
        ))
    ) {
      throw new Error(`Invalid required properties at ${path}`)
    }
    for (const key of ['items', 'additionalProperties']) {
      if (
        node[key] !== undefined &&
        !(key === 'additionalProperties' && typeof node[key] === 'boolean')
      ) {
        visit(node[key], `${path}.${key}`, depth + 1)
      }
    }
    for (const key of ['anyOf', 'oneOf']) {
      if (node[key] !== undefined) {
        const alternatives = node[key]
        if (!Array.isArray(alternatives) || !alternatives.length) {
          throw new Error(`Invalid ${key} at ${path}`)
        }
        for (const value of alternatives) {
          visit(value, `${path}.${key}`, depth + 1)
        }
      }
    }
    for (const key of ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']) {
      const value = node[key]
      if (
        value !== undefined &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          (!['minimum', 'maximum'].includes(key) && (!Number.isSafeInteger(value) || value < 0)))
      ) {
        throw new Error(`Invalid ${key} at ${path}`)
      }
    }
    for (const [min, max] of [
      ['minimum', 'maximum'],
      ['minItems', 'maxItems'],
      ['minLength', 'maxLength']
    ]) {
      if (typeof node[min] === 'number' && typeof node[max] === 'number' && node[min] > node[max]) {
        throw new Error(`Contradictory bounds at ${path}`)
      }
    }
    if (
      node.enum !== undefined &&
      (!Array.isArray(node.enum) || !node.enum.length || !node.enum.every(isScalar))
    ) {
      throw new Error(`Unsupported enum at ${path}`)
    }
    if (Object.hasOwn(node, 'const') && !isScalar(node.const)) {
      throw new Error(`Unsupported const at ${path}`)
    }
    if (node.pattern !== undefined) {
      if (typeof node.pattern !== 'string') {
        throw new Error(`Invalid pattern at ${path}`)
      }
      new RegExp(node.pattern)
    }
    if (node.description !== undefined && typeof node.description !== 'string') {
      throw new Error(`Invalid description at ${path}`)
    }
    active.delete(node)
  }
  visit(schema, '$', 0)
  const rootProblem = unusableAgentSchemaReason(schema)
  if (rootProblem) {
    throw new Error(rootProblem)
  }
}
