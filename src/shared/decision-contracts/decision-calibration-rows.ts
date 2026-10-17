import type { ConfidencePolicy, DecisionContract } from './decision-contract-types'

// One golden item as JEV judged it under a contract's policy; every derived field recomputes from the primitives.

/** A golden label: yes/no for gates and routes, a/b for pairs (b is the challenger that would replace a). */
export type GoldenTruth = 'yes' | 'no' | 'unknown' | 'a' | 'b' | 'tie'
export type CalibrationDecision = 'yes' | 'no' | 'a' | 'b'
export type CalibrationTokens = { input: number; output: number }

export const CALIBRATION_BANDS = [
  'sure',
  '0.8-0.9',
  '0.65-0.8',
  'low',
  'unsure',
  'unknown'
] as const
export type CalibrationBand = (typeof CALIBRATION_BANDS)[number]

/** What JEV answered for one item: its decision, how likely that side was, and the policy's unsure call. */
export type JevDecided = {
  decision: CalibrationDecision
  probability: number | null
  unsure: boolean
}
export type JevReading = { failed: string } | JevDecided

export type CalibrationRow = {
  id: string
  truth: GoldenTruth
  decision: CalibrationDecision | null
  /** JEV's probability for the side it decided; null when it gave none. */
  probability: number | null
  unsure: boolean
  failed?: string
  tokens: CalibrationTokens | null
  band: CalibrationBand
  /** JEV's decision stood without a fallback: the rows a confident miss can come from. */
  alone: boolean
  /** Null when the truth is unknown or a tie, or JEV gave no decision: never counted as agreement. */
  agree: boolean | null
}

const Z = 1.959964

/** Wilson score 95% upper bound on a miss rate; with no evidence it is 1. */
export function wilsonUpper(misses: number, n: number): number {
  if (n <= 0) {
    return 1
  }
  const p = misses / n
  const z2 = Z * Z
  const centre = p + z2 / (2 * n)
  const spread = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return Math.min(1, (centre + spread) / (1 + z2 / n))
}

/** The band of one reading: the policy's own unsure call first, then how sure JEV was of its side. */
export function calibrationBand(reading: JevReading): CalibrationBand {
  if ('failed' in reading) {
    return 'unknown'
  }
  if (reading.unsure) {
    return 'unsure'
  }
  const p = reading.probability
  if (p === null) {
    return 'unknown'
  }
  return p >= 0.9 ? 'sure' : p >= 0.8 ? '0.8-0.9' : p >= 0.65 ? '0.65-0.8' : 'low'
}

/** NOUL: p is P(yes); inside the band, both ends included, JEV is unsure (workflow-one-answer.ts). */
export function noulReading(
  policy: Extract<ConfidencePolicy, { method: 'noul' }>,
  p: number
): JevDecided {
  const [low, high] = policy.band
  const decision = p > high || (p >= low && p >= 0.5) ? 'yes' : 'no'
  return {
    decision,
    probability: decision === 'yes' ? p : 1 - p,
    unsure: p >= low && p <= high
  }
}

/** Score line: the item passes at or above the line; its probability is P(level ≥ line) when levels exist. */
export function scoreLineReading(
  policy: Extract<ConfidencePolicy, { method: 'score-line' }>,
  score: number,
  levels?: readonly number[]
): JevDecided {
  const decision = score >= policy.below ? 'yes' : 'no'
  const pass = levels?.length
    ? levels.slice(Math.ceil(policy.below)).reduce((sum, value) => sum + value, 0)
    : null
  return {
    decision,
    probability: pass === null ? null : decision === 'yes' ? pass : 1 - pass,
    unsure: false
  }
}

/** A pair judged in both orders: P(b better) is the mean of b shown first and 1 − a shown first. */
export function pairReading(
  winner: 'a' | 'b',
  unsure: boolean,
  pairs?: readonly { first: string; second: string; probability: number }[]
): JevDecided {
  const shown = (first: string) => pairs?.find((pair) => pair.first === first)?.probability
  const [bFirst, aFirst] = [shown('b'), shown('a')]
  const pb = bFirst === undefined || aFirst === undefined ? null : (bFirst + 1 - aFirst) / 2
  return {
    decision: winner,
    probability: pb === null ? null : winner === 'b' ? pb : 1 - pb,
    unsure
  }
}

/** The side a contract's gate acts on: a score line sets aside or drops below it; a pair replaces with b. */
function actionSide(contract: DecisionContract): CalibrationDecision {
  switch (contract.confidence.method) {
    case 'score-line':
      return 'no'
    case 'noul':
      return 'yes'
    case 'auto':
    case 'pairwise':
    case 'scores':
      return 'b'
  }
}

/** A miss on the side the contract's `harm` names as costly; symmetric harm makes every miss costly. */
export function costlyMiss(
  contract: DecisionContract,
  decision: CalibrationDecision,
  truth: GoldenTruth
): boolean {
  if (decision === truth) {
    return false
  }
  if (contract.harm === 'symmetric') {
    return true
  }
  const acted = decision === actionSide(contract)
  return contract.harm === 'false-yes' ? acted : !acted
}

/** A row from what JEV answered; the same function checks a committed row's derived fields. */
export function calibrationRow(
  id: string,
  truth: GoldenTruth,
  reading: JevReading,
  tokens: CalibrationTokens | null
): CalibrationRow {
  const band = calibrationBand(reading)
  if ('failed' in reading) {
    return {
      id,
      truth,
      decision: null,
      probability: null,
      unsure: false,
      failed: reading.failed,
      tokens,
      band,
      alone: false,
      agree: null
    }
  }
  const known = truth !== 'unknown' && truth !== 'tie'
  return {
    id,
    truth,
    decision: reading.decision,
    probability: reading.probability,
    unsure: reading.unsure,
    tokens,
    band,
    alone: !reading.unsure,
    agree: known ? reading.decision === truth : null
  }
}

/** The reading a committed row claims, so its derived fields can be recomputed. */
export function readingOfRow(row: CalibrationRow): JevReading {
  return row.decision === null
    ? { failed: row.failed ?? 'no decision' }
    : { decision: row.decision, probability: row.probability, unsure: row.unsure }
}
