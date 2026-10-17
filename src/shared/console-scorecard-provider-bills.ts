import { z } from 'zod'
import { looseNumber, looseText } from './console-scorecard-leaves'

// ── provider bills beside the logged API cost ─────────────────────────────────
// Sal, 2026-09-29: "Show provider bills in omniIDE". Every API-cost figure
// elsewhere in the scorecard is our own `api_cost_log`, a floor: the vendors
// bill hundreds of dollars a day more than the two brands log. This block is
// one UTC day per row of what the vendors BILLED next to what we LOGGED.
//
// Estate-wide, so the relay drops it for a company-scoped reader: absent means
// "do not draw the section". Every figure is null when its read failed or was
// never made — unknown, never $0. The block is an addition to the page, so a
// malformed part is dropped (or the whole block is null) rather than failing
// the document every other figure on the page comes from.

/** A figure, or null when it is absent, null, or not a number at all. */
const billFigure = looseNumber.catch(null).transform((value) => value ?? null)

/**
 * `{ vendor: number | null }`, vendor keys open-ended so a vendor the collector
 * adds later (BytePlus billing is in flight) still shows. An unreadable entry
 * stays in the map as unknown; a non-object map is null.
 */
const moneyMap = z.record(z.string(), z.unknown()).transform((entries) => {
  const out: Record<string, number | null> = {}
  for (const [key, raw] of Object.entries(entries)) {
    const parsed = billFigure.safeParse(raw)
    out[key] = parsed.success ? parsed.data : null
  }
  return out
})

export const providerBillsDay = z
  .object({
    date: z.string().min(1),
    /** Today so far; a day whose completeness is not stated counts as partial. */
    partial: z
      .unknown()
      .optional()
      .transform((value) => value !== false),
    /** Per vendor meter (`openrouter_app`, `openrouter_other`, `fal`, …); null = no read. */
    billed: moneyMap.catch({}),
    /** PiAPI is prepaid: top-ups, not usage, so it is kept out of `billed_known_usd`. */
    piapi_topups: billFigure,
    /** The sum of the vendors that answered — a floor, not the whole bill. */
    billed_known_usd: billFigure,
    /** OmniRogue + BetaCorp `api_cost_log`, per vendor plus `total`; null when unread. */
    logged: moneyMap.nullable().catch(null),
    /** Billed minus logged, only for vendors with a bill (OpenRouter, fal). */
    unlogged_known: moneyMap.nullable().catch(null)
  })
  .passthrough()

export const providerBills = z
  .object({
    basis: looseText.catch(null).transform((value) => value ?? null),
    timezone: z.string().min(1).catch('UTC'),
    /** Vendors the collector cannot read a bill for yet (`byteplus`, `google`, …). */
    not_connected: z
      .array(z.unknown())
      .catch([])
      .transform((names) =>
        names.filter((name): name is string => typeof name === 'string' && name !== '')
      ),
    /** Oldest first; the last one is usually today, partial. A row without a date is dropped. */
    days: z
      .array(z.unknown())
      .catch([])
      .transform((rows) =>
        rows.flatMap((row) => {
          const parsed = providerBillsDay.safeParse(row)
          return parsed.success ? [parsed.data] : []
        })
      )
  })
  .passthrough()

export type ProviderBillsDay = z.infer<typeof providerBillsDay>
export type ProviderBills = z.infer<typeof providerBills>
