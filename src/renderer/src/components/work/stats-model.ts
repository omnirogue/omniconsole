import {
  everySourceHealthy,
  failedSources,
  listCoverage,
  sourcesForField,
  sourcesWithPrefix,
  SCORECARD_STALE_MINUTES,
  type CostBreakdown,
  type CostDimension,
  type CostRow,
  type ScorecardDocument
} from '../../../../shared/console-scorecard-contract'

/**
 * What a stat is, and the five rules every stat in this folder keeps. They are the
 * reason the arithmetic lives here rather than inline in the components.
 *
 *  1. A figure nobody read is `null` and prints an em dash. Never 0, never 0%.
 *  2. A company that bills no API tenant draws NO API-cost tile at all. A $0.00
 *     would read as "we measured, and it was nothing".
 *  3. A sum of nothing is `null`; a ratio with a null or zero denominator is `null`.
 *  4. A failed or stale source SUPPRESSES its figure and names itself, because a
 *     decoded zero from a broken read looks exactly like a healthy quiet day.
 *  5. A capped list says how much it is showing of how many.
 */

export type Stat = {
  id: string
  label: string
  /** The figure, or null when it was not read. */
  value: number | null
  kind: 'money' | 'count' | 'percent' | 'hours' | 'ratio'
  caption?: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
  /** Set when the figure is withheld, naming what is missing. */
  withheld?: string
}

export type { CostDimension, CostRow }

/** A usable number, or null. Every stat function reaches a figure through this. */
export function statNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const number = statNumber

export function costRows(
  breakdown: CostBreakdown | null | undefined,
  dimension: CostDimension
): CostRow[] | null {
  const rows = breakdown?.[dimension]
  if (rows === null || rows === undefined) {
    return null
  }
  return [...rows].sort((left, right) => (number(right.cost) ?? 0) - (number(left.cost) ?? 0))
}

/** "12 of 30 supplied rows" when a dimension was truncated. */
export function costDimensionNote(
  breakdown: CostBreakdown | null | undefined,
  dimension: CostDimension
): string | null {
  const quality = breakdown?.dimension_quality?.[dimension]
  if (!quality || quality.state !== 'partial') {
    return null
  }
  const returned = number(quality.returned)
  const supplied = number(quality.supplied)
  return returned !== null && supplied !== null
    ? `Partial dimension: ${returned} of ${supplied} supplied rows.`
    : 'This dimension is partial.'
}

export type CoverageNote = { scope: string; detail: string }

/**
 * Why a figure is missing, gathered per company so a failed customer-service read
 * never makes the finance numbers look suspect.
 */
export function coverageNotes(document: ScorecardDocument | null | undefined): CoverageNote[] {
  if (!document) {
    return []
  }
  const notes: CoverageNote[] = []
  for (const company of document.companies) {
    const name = company.name ?? company.slug
    const failed = failedSources(company.sources)
    if (failed.length > 0) {
      notes.push({ scope: name, detail: `money sources failed: ${failed.join(', ')}` })
    }
    for (const [label, block] of [
      ['finance', document.finance?.[company.slug]],
      ['customer service', document.customer_service?.[company.slug]],
      ['operations', document.operations?.[company.slug]]
    ] as const) {
      const broken = failedSources(block?.sources)
      if (broken.length > 0) {
        notes.push({ scope: `${name} · ${label}`, detail: `sources failed: ${broken.join(', ')}` })
      }
    }
  }
  const estate = failedSources(document.sources)
  if (estate.length > 0) {
    notes.push({ scope: 'Estate', detail: `sources failed: ${estate.join(', ')}` })
  }
  return notes
}

export {
  everySourceHealthy,
  listCoverage,
  SCORECARD_STALE_MINUTES,
  sourcesForField,
  sourcesWithPrefix
}
