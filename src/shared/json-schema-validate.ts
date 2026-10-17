/**
 * A small JSON Schema checker for the shapes agents are asked to return: object roots,
 * properties, required, items, enums, bounds and patterns. Validation happens at the
 * runtime boundary so a malformed answer is retried by the agent, never patched by the
 * script that asked for it. Unsupported keywords are ignored rather than guessed at.
 */
export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  minItems?: number
  maxItems?: number
  enum?: unknown[]
  const?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  description?: string
}

export type JsonSchemaProblem = { path: string; message: string }

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number'
  }
  return typeof value
}

function matchesType(actual: string, wanted: string): boolean {
  return actual === wanted || (wanted === 'number' && actual === 'integer')
}

function check(schema: JsonSchema, value: unknown, path: string, out: JsonSchemaProblem[]): void {
  if (!schema || typeof schema !== 'object') {
    return
  }
  const actual = typeOf(value)
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!wanted.some((type) => matchesType(actual, type))) {
      out.push({ path, message: `expected ${wanted.join(' | ')}, got ${actual}` })
      return
    }
  }
  if (schema.enum && !schema.enum.some((option) => Object.is(option, value) || option === value)) {
    out.push({ path, message: `expected one of ${schema.enum.map(String).join(', ')}` })
  }
  if ('const' in schema && schema.const !== value) {
    out.push({ path, message: `expected ${String(schema.const)}` })
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.push({ path, message: `expected at least ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.push({ path, message: `expected at most ${schema.maximum}` })
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push({ path, message: `expected at least ${schema.minLength} characters` })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push({ path, message: `expected at most ${schema.maxLength} characters` })
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      out.push({ path, message: `expected to match ${schema.pattern}` })
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push({ path, message: `expected at least ${schema.minItems} items` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push({ path, message: `expected at most ${schema.maxItems} items` })
    }
    if (schema.items) {
      value.forEach((item, index) => check(schema.items!, item, `${path}[${index}]`, out))
    }
  }
  if (actual === 'object' && value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        out.push({ path: path ? `${path}.${key}` : key, message: 'is required' })
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        check(child, record[key], path ? `${path}.${key}` : key, out)
      }
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const key of Object.keys(record)) {
        if (schema.properties && key in schema.properties) {
          continue
        }
        if (schema.additionalProperties === false) {
          out.push({ path: path ? `${path}.${key}` : key, message: 'is not allowed' })
        } else {
          check(schema.additionalProperties, record[key], path ? `${path}.${key}` : key, out)
        }
      }
    }
  }
  const alternatives = schema.anyOf ?? schema.oneOf
  if (alternatives?.length) {
    const passing = alternatives.filter((option) => validateJsonSchema(option, value).length === 0)
    if (passing.length === 0 || (schema.oneOf && passing.length !== 1)) {
      out.push({
        path,
        message: `matches ${passing.length} of ${alternatives.length} alternatives`
      })
    }
  }
}

/** Every way `value` fails `schema`; empty means it conforms. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): JsonSchemaProblem[] {
  const problems: JsonSchemaProblem[] = []
  check(schema, value, '', problems)
  return problems
}

export function describeJsonSchemaProblems(problems: readonly JsonSchemaProblem[]): string {
  return problems.map((problem) => `${problem.path || '$'}: ${problem.message}`).join('; ')
}

/**
 * The shape an agent may be asked for: an object root with named properties and a
 * `required` list drawn from them. Anything else cannot be asked of an agent, so it is
 * refused when the script calls, not when the answer comes back.
 */
export function unusableAgentSchemaReason(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return 'schema must be an object'
  }
  const root = schema as JsonSchema
  if (root.type !== 'object') {
    return "schema root must have type 'object'"
  }
  if (!root.properties || typeof root.properties !== 'object') {
    return 'schema root must declare properties'
  }
  const missing = (root.required ?? []).filter((key) => !(key in root.properties!))
  if (missing.length > 0) {
    return `required names properties the schema does not declare: ${missing.join(', ')}`
  }
  return null
}
