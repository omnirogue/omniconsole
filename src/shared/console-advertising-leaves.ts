import { z } from 'zod'

/**
 * The leaves every advertising contract shares, and the one rule they exist to
 * keep: a measure nobody reported is `null`, never zero, and a cost per result is
 * derived from the two figures on screen so a zero-count object never shows a
 * free conversion.
 */

/** A non-negative measure, or null when the provider did not report one. */
export const measure = z.number().finite().nonnegative().nullable().catch(null)
export const optionalText = z
  .string()
  .nullable()
  .optional()
  .transform((value) => value ?? null)
export const nonNegativeCount = z.number().int().nonnegative()
export const instant = z.string().datetime({ offset: true })

/**
 * Cost per result, from the two figures on screen. A zero or missing denominator
 * has no cost — presenting one would invent a free conversion.
 */
export function unitCost(numerator: number | null, denominator: number | null): number | null {
  return numerator !== null &&
    denominator !== null &&
    Number.isFinite(numerator) &&
    numerator >= 0 &&
    Number.isFinite(denominator) &&
    denominator > 0
    ? numerator / denominator
    : null
}
