import { validateJsonSchema, type JsonSchema } from '../../../shared/json-schema-validate'

/** Project optional properties to strict-provider required fields with nullable values. */
export function workflowStrictSchema(
  schema: JsonSchema,
  omitNonWhitespacePattern = false
): JsonSchema {
  const visit = (node: JsonSchema): JsonSchema => {
    const { pattern, ...withoutPattern } = node
    const providerNode = omitNonWhitespacePattern && pattern === '\\S' ? withoutPattern : node
    return {
      ...providerNode,
      ...(node.properties
        ? {
            properties: Object.fromEntries(
              Object.entries(node.properties).map(([key, value]) => [
                key,
                node.required?.includes(key)
                  ? visit(value)
                  : { anyOf: [visit(value), { type: 'null' }] }
              ])
            ),
            required: Object.keys(node.properties),
            additionalProperties: false
          }
        : {}),
      ...(node.items ? { items: visit(node.items) } : {}),
      ...(node.anyOf ? { anyOf: node.anyOf.map(visit) } : {}),
      ...(node.oneOf ? { oneOf: node.oneOf.map(visit) } : {})
    }
  }
  return visit(schema)
}

/** Remove only null placeholders introduced for optional properties by the projection. */
export function workflowOriginalValue(schema: JsonSchema, value: unknown): unknown {
  if (Array.isArray(value)) {
    return schema.items ? value.map((item) => workflowOriginalValue(schema.items!, item)) : value
  }
  if (!value || typeof value !== 'object' || !schema.properties) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const property = schema.properties![key]
      if (!property) {
        return [[key, item]]
      }
      if (
        item === null &&
        !schema.required?.includes(key) &&
        validateJsonSchema(property, null).length > 0
      ) {
        return []
      }
      return [[key, workflowOriginalValue(property, item)]]
    })
  )
}
