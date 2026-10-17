import { z } from 'zod'

/**
 * The leaves the scorecard's four blocks share.
 *
 * The collector's own rule, which these types exist to preserve: a provider that
 * did not answer leaves `null`, never zero, and the `sources` list beside the
 * figure says which one and why. Decoding is tolerant on numbers and keeps
 * unknown keys, so a newer collector never breaks an older client.
 */

/**
 * A money or count field that may be absent, null, a number, or a NUMERIC STRING.
 *
 * The string case is not defensiveness, it is fidelity: the console's own decoder
 * coerces it, and its comment says why — "Meta reports spend as text". A schema that
 * rejected `"12.5"` would refuse a live payload and blank every figure in the document,
 * where the console shows the number. Anything that is not a finite number after
 * coercion stays null, which is the same answer the console gives.
 */
const numeric = z.preprocess((value) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' || !Number.isFinite(Number(trimmed)) ? null : Number(trimmed)
  }
  return value
}, z.number().finite().nullable())

export const looseNumber = numeric.nullable().optional()
export const looseCount = numeric.nullable().optional()

/**
 * A count the original folds to zero when it cannot read one (`optNum(x) ?? 0`).
 *
 * Every numeric leaf in this folder must come from here. A bare `z.number()` rejects the
 * numeric string the collector may emit, and because nothing in the document carries a
 * per-row `.catch()`, one such field fails the WHOLE parse and blanks every stat — which
 * is exactly the outage the coercion above exists to prevent. `console-scorecard-leaf-coverage.test.ts`
 * fails if a bare numeric leaf reappears, because this rule has now been missed three times.
 */
export const countOrZero = numeric
  .nullable()
  .optional()
  .transform((value) => value ?? 0)

/**
 * A string the original coerces rather than requires (`String(x ?? '')`). A numeric id
 * from a desk with integer primary keys is a string to a reader, not a failed document.
 */
export const coercedText = z.preprocess(
  (value) =>
    value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value),
  z.string()
)

/**
 * A label the original treats as absent when it is not a string, substituting a fallback
 * (`optStr(x) ?? …`). A wrong-typed title must not fail the row that carries it.
 */
export function looseLabel(
  fallback = ''
): z.ZodDefault<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodString>> {
  return z
    .preprocess(
      (value) => (typeof value === 'string' && value !== '' ? value : fallback),
      z.string()
    )
    .default(fallback) as never
}

/**
 * A map of counts where an unreadable entry is DROPPED and the rest kept, which is what
 * the original's loop does. Failing the map would lose every readable count with it.
 */
export const countMap = z
  .record(z.string(), z.unknown())
  .optional()
  .transform((value) => {
    const out: Record<string, number> = {}
    for (const [key, raw] of Object.entries(value ?? {})) {
      const parsed = numeric.safeParse(raw)
      if (parsed.success && parsed.data !== null) {
        out[key] = parsed.data
      }
    }
    return out
  })
export const looseText = z.string().nullable().optional()
export const looseBool = z.boolean().nullable().optional()

export const FINANCIAL_FIELDS = ['revenue', 'ad_spend', 'api_cost', 'pnl'] as const
export type FinancialField = (typeof FINANCIAL_FIELDS)[number]
export const financialField = z.enum(FINANCIAL_FIELDS)

/** Which source produced a figure, and whether it answered at all. */
export const scorecardSource = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    error: looseText,
    fetched_at: looseText,
    note: looseText
  })
  .passthrough()
export type ScorecardSource = z.infer<typeof scorecardSource>

/** How much of a window a figure actually covered. */
export const moneyCoverage = z
  .object({ state: looseText, observed: looseCount, expected: looseCount })
  .passthrough()

export const financialSources = z.record(z.string(), z.array(scorecardSource)).optional()

/**
 * The sources behind ONE field. Newer documents name each metric's own
 * dependencies; older ones carry a single list for the whole block, and a
 * per-field question has to be answered from that.
 */
export function sourcesForField(
  value:
    | {
        sources?: readonly ScorecardSource[]
        financial_sources?: Record<string, ScorecardSource[]>
      }
    | null
    | undefined,
  field: FinancialField
): readonly ScorecardSource[] {
  if (value?.financial_sources !== undefined) {
    return value.financial_sources[field] ?? []
  }
  return value?.sources ?? []
}

/** Sources that failed, by name — what to show instead of the figure they fed. */
export function failedSources(sources: readonly ScorecardSource[] | undefined): string[] {
  return (sources ?? []).filter((source) => !source.ok).map((source) => source.name)
}

/** True when every source in the list answered; an empty list vouches for nothing. */
export function everySourceHealthy(sources: readonly ScorecardSource[] | undefined): boolean {
  return sources !== undefined && sources.length > 0 && sources.every((source) => source.ok)
}

/** Sources whose name starts with a prefix, e.g. `stripe:` or `meta:`. */
export function sourcesWithPrefix(
  sources: readonly ScorecardSource[] | undefined,
  prefix: string
): readonly ScorecardSource[] {
  return (sources ?? []).filter((source) => source.name.startsWith(prefix))
}
