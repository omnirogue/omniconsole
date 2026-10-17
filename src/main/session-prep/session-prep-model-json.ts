import { z } from 'zod'
import {
  SESSION_PREP_RECOMMENDED_EFFORTS,
  type PreparedFields
} from '../../shared/session-prep-types'

/**
 * First JSON object in a model reply, tolerating fences and surrounding prose. Scans for the
 * object that closes the first "{" (strings respected), so trailing prose with braces is ignored.
 */
export function extractJsonObject(raw: string): unknown {
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    const end = matchingBrace(raw, start)
    if (end === -1) {
      continue
    }
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      // Why: a "{" inside prose ({TBD}) is not the object; try the next one.
    }
  }
  return null
}

function matchingBrace(raw: string, start: number): number {
  let depth = 0
  let inString = false
  for (let index = start; index < raw.length; index++) {
    const char = raw[index]
    if (inString) {
      if (char === '\\') {
        index++
      } else if (char === '"') {
        inString = false
      }
    } else if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) {
        return index
      }
    }
  }
  return -1
}

export function parseModelJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  const value = extractJsonObject(raw)
  if (value === null || typeof value !== 'object') {
    return null
  }
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const trimmed = z.string().trim()
const nonEmptyList = z.array(trimmed).transform((items) => items.filter((item) => item.length > 0))

export const preparedFieldsSchema: z.ZodType<PreparedFields> = z.object({
  title: trimmed,
  outcome: trimmed,
  doneWhen: nonEmptyList,
  decided: nonEmptyList,
  references: z.array(
    z.object({
      path: trimmed.min(1),
      why: trimmed.min(1)
    })
  ),
  constraints: nonEmptyList,
  assumptions: nonEmptyList,
  blockingQuestion: z
    .object({
      question: trimmed.min(1),
      options: z.array(trimmed).transform((opts) => opts.filter((opt) => opt.length > 0)),
      why: trimmed
    })
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  changesCode: z.boolean(),
  // Why catch: an unknown level only loses the recommendation; the agent's default applies.
  effort: z.enum(SESSION_PREP_RECOMMENDED_EFFORTS).optional().catch(undefined),
  repo: z
    .string()
    .trim()
    .nullish()
    .transform((value) => value || undefined)
    .catch(undefined)
})

export const PREP_JSON_RETRY_LINE =
  'Your previous reply was not valid JSON for the schema. Return only the JSON object.'
