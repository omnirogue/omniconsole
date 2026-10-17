import type {
  ProviderBills,
  ProviderBillsDay,
  ScorecardSource
} from '../../../../shared/console-scorecard-contract'

/**
 * Provider bills beside the logged API cost, without React (Sal, 2026-09-29:
 * "figure out why tracking is wrong", then "Show provider bills in omniIDE").
 * Mirrors the web scorecard (omni-console #570). Three rules:
 *
 *  1. Unknown is "—", never $0. A vendor whose bill was not read, a day whose
 *     log was not read, a gap nobody could compute — each stays null.
 *  2. Billed and Logged are not the same set of vendors: Billed is only the
 *     vendors with a billing read, Logged is every vendor both brands log. The
 *     honest comparison is per vendor (`unlogged_known`), so "Not logged" is the
 *     headline and the two totals sit beside it for scale only.
 *  3. The days are UTC while the rest of the scorecard is New York time; the
 *     section says so rather than letting the two clocks blur together.
 */

/** The word for a figure nobody read. */
export const UNKNOWN = '—'

/** The collector's source rows for this section. */
export const PROVIDER_BILL_SOURCES: readonly string[] = ['provider-bills', 'provider-bills-logged']

const VENDOR_NAMES: Readonly<Record<string, string>> = {
  openrouter: 'OpenRouter',
  openrouter_app: 'OpenRouter (app key)',
  openrouter_other: 'OpenRouter (other keys)',
  fal: 'fal',
  byteplus: 'BytePlus',
  google: 'Google',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  piapi: 'PiAPI',
  other: 'Other'
}

/** A vendor key as its brand writes it: `openai` → OpenAI, `fal` stays fal, unknown keys capitalised. */
export function vendorName(key: string): string {
  return VENDOR_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' ')
}

/** Dollars to the cent — these are vendor bills, compared a few dollars apart. */
export function billMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNKNOWN
  }
  const text = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    Math.abs(value)
  )
  // U+2212, not a hyphen, as the Work stats write a negative.
  return value < 0 ? `−${text}` : text
}

/** The sum of the figures that were read, or null when none was — a missing vendor never adds $0. */
function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null && Number.isFinite(value))
  return known.length > 0 ? known.reduce((total, value) => total + value, 0) : null
}

export type ProviderBillsRow = {
  date: string
  /** "Latest complete day" / "Today so far, UTC" in the headline; "so far" or '' in the table. */
  label: string
  partial: boolean
  billed: number | null
  logged: number | null
  notLogged: number | null
  /** "OpenRouter $341.03 · fal $122.55" — the per-vendor gap, unknowns as "—". */
  notLoggedDetail: string | null
  /** Every billed meter, for the hover on the billed figure. */
  billedDetail: string | null
}

function row(day: ProviderBillsDay, label: string): ProviderBillsRow {
  const unlogged = Object.entries(day.unlogged_known ?? {})
  const billed = Object.entries(day.billed)
  return {
    date: day.date,
    label,
    partial: day.partial,
    billed: day.billed_known_usd,
    logged: day.logged?.total ?? null,
    notLogged: sumKnown(unlogged.map(([, value]) => value)),
    notLoggedDetail:
      unlogged.length > 0
        ? unlogged.map(([key, value]) => `${vendorName(key)} ${billMoney(value)}`).join(' · ')
        : null,
    billedDetail:
      billed.length > 0
        ? billed
            .map(
              ([key, value]) =>
                `${vendorName(key)} ${value === null ? 'not read' : billMoney(value)}`
            )
            .join(' · ')
        : null
  }
}

export type ProviderBillsView = {
  /** The last day with `partial: false`, then today so far — whichever exist. */
  headline: ProviderBillsRow[]
  /** Every day, oldest first, for the seven-day table. */
  days: ProviderBillsRow[]
  /** "No billing read yet: BytePlus, Google, OpenAI, Anthropic", or null when every vendor is read. */
  notConnected: string | null
  basis: string | null
  /** "Days are UTC; the rest of the scorecard is America/New_York." */
  clockNote: string
  /** The collector's `provider-bills*` source rows that failed on this read. */
  failures: ScorecardSource[]
}

/** The section's rows, or null when the scorecard carried no `provider_bills` — the section is then not drawn. */
export function providerBillsView(
  bills: ProviderBills | null | undefined,
  sources: readonly ScorecardSource[] = [],
  scorecardTimezone: string | null | undefined = 'America/New_York'
): ProviderBillsView | null {
  if (!bills) {
    return null
  }
  const complete = bills.days.findLast((day) => !day.partial) ?? null
  const last = bills.days.at(-1) ?? null
  const today = last && last.partial ? last : null
  return {
    headline: [
      ...(complete ? [row(complete, 'Latest complete day')] : []),
      ...(today ? [row(today, `Today so far, ${bills.timezone}`)] : [])
    ],
    days: bills.days.map((day) => row(day, day.partial ? 'so far' : '')),
    notConnected:
      bills.not_connected.length > 0
        ? `No billing read yet: ${bills.not_connected.map(vendorName).join(', ')}`
        : null,
    basis: bills.basis,
    clockNote: `Days are ${bills.timezone}; the rest of the scorecard is ${scorecardTimezone || 'America/New_York'}.`,
    failures: sources.filter((source) => PROVIDER_BILL_SOURCES.includes(source.name) && !source.ok)
  }
}
