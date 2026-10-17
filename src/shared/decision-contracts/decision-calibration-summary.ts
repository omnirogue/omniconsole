import {
  CALIBRATION_BANDS,
  calibrationRow,
  costlyMiss,
  readingOfRow,
  wilsonUpper,
  type CalibrationBand,
  type CalibrationRow,
  type CalibrationTokens,
  type GoldenTruth
} from './decision-calibration-rows'
import type { ContractRef, DecisionContract } from './decision-contract-types'

export type MissCount = { n: number; misses: number; rate: number | null; upper: number }

export type BandSummary = {
  band: CalibrationBand
  n: number
  /** Rows with a known truth and a decision: the only ones agreement is counted on. */
  known: number
  agree: number
  disagreeRate: number | null
  upper: number
  tokens: CalibrationTokens | 'unknown'
}

export type CalibrationSummary = {
  n: number
  truths: Partial<Record<GoldenTruth, number>>
  bands: BandSummary[]
  /** Share of items that went to the contract's fallback: unsure, or no decision at all. */
  escalationShare: number | null
  /** Of every known item JEV decided, sure or unsure, the share it got right. */
  accuracy: number | null
  /** Misses among the known items JEV decided alone. */
  confident: MissCount
  /** Of those, misses on the side the contract's harm names as costly. */
  costly: MissCount
  tokens: CalibrationTokens | 'unknown'
}

/** A calibration result as committed under calibration/<id>.v<N>.json. */
export type CalibrationFile = {
  contract: ContractRef
  contractDigest: string
  golden: { set: string; version: number }
  goldenDigest: string
  jevModel: string
  commit: string
  command: string
  ranAt: string
  rows: CalibrationRow[]
  summary: CalibrationSummary
}

/** JSON with sorted keys, so a digest or a comparison never depends on key order. */
export function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === 'object'
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, sort((entry as Record<string, unknown>)[key])])
          )
        : entry
  return JSON.stringify(sort(value))
}

const round = (value: number) => Math.round(value * 1e6) / 1e6
const share = (part: number, whole: number) => (whole ? round(part / whole) : null)

function misses(n: number, count: number): MissCount {
  return { n, misses: count, rate: share(count, n), upper: round(wilsonUpper(count, n)) }
}

/** Summed tokens; unknown unless every row reported them, never a partial count. */
function tokensOf(rows: readonly CalibrationRow[]): CalibrationTokens | 'unknown' {
  if (rows.some((row) => !row.tokens)) {
    return 'unknown'
  }
  return rows.reduce(
    (sum, row) => ({
      input: sum.input + row.tokens!.input,
      output: sum.output + row.tokens!.output
    }),
    { input: 0, output: 0 }
  )
}

export function summarizeCalibration(
  contract: DecisionContract,
  rows: readonly CalibrationRow[]
): CalibrationSummary {
  const truths: Partial<Record<GoldenTruth, number>> = {}
  for (const row of rows) {
    truths[row.truth] = (truths[row.truth] ?? 0) + 1
  }
  const known = rows.filter((row) => row.agree !== null)
  const alone = known.filter((row) => row.alone)
  return {
    n: rows.length,
    truths,
    bands: CALIBRATION_BANDS.map((band) => {
      const inBand = rows.filter((row) => row.band === band)
      const counted = inBand.filter((row) => row.agree !== null)
      const agree = counted.filter((row) => row.agree).length
      return {
        band,
        n: inBand.length,
        known: counted.length,
        agree,
        disagreeRate: share(counted.length - agree, counted.length),
        upper: round(wilsonUpper(counted.length - agree, counted.length)),
        tokens: tokensOf(inBand)
      }
    }),
    escalationShare: share(rows.filter((row) => !row.alone).length, rows.length),
    accuracy: share(known.filter((row) => row.agree).length, known.length),
    confident: misses(alone.length, alone.filter((row) => !row.agree).length),
    costly: misses(
      alone.length,
      alone.filter((row) => costlyMiss(contract, row.decision!, row.truth)).length
    ),
    tokens: tokensOf(rows)
  }
}

/** Why a committed file does not hold: a row whose derived fields or a summary that does not recompute. */
export function calibrationFileProblems(
  file: CalibrationFile,
  contract: DecisionContract,
  golden: readonly { id: string; truth: GoldenTruth }[]
): string[] {
  const labels = canonicalJson(golden.map(({ id, truth }) => ({ id, truth })))
  const problems =
    canonicalJson(file.rows.map(({ id, truth }) => ({ id, truth }))) === labels
      ? []
      : ["the rows are not the golden set's items and labels, in order"]
  for (const row of file.rows) {
    const again = calibrationRow(row.id, row.truth, readingOfRow(row), row.tokens)
    if (canonicalJson(again) !== canonicalJson(row)) {
      problems.push(`row ${row.id} does not recompute from its decision, probability and truth`)
    }
  }
  if (canonicalJson(summarizeCalibration(contract, file.rows)) !== canonicalJson(file.summary)) {
    problems.push('the summary does not recompute from the rows')
  }
  return problems
}
