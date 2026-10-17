import type { GoldenTruth } from './decision-calibration-rows'
import { summarizeCalibration, type CalibrationFile } from './decision-calibration-summary'
import { contractByRef, CURRENT_CONTRACTS, LIVE_FINDING_VERIFY } from './decision-contract-library'
import { contractRefOf, type ContractRef, type DecisionContract } from './decision-contract-types'

export type CalibrationState = 'uncalibrated' | 'stale' | 'measured' | 'failing' | 'calibrated'

/** What a status is judged against today; digests are computed outside shared code (no node:crypto here). */
export type CalibrationEvidence = {
  file?: CalibrationFile
  current: {
    contractDigest: string
    jevModel: string
    /** The golden set the file names, as it is on disk now; absent when it is gone. */
    golden?: { digest: string; status: 'skeleton' | 'reviewed'; reviewedBy?: string }
  }
}

/** Fewer known items than this on either side of the truth cannot show both kinds of miss. */
export const MIN_ITEMS_PER_SIDE = 10

/** Every contract new runs resolve to: each template's own, the generic one of each kind, and live verify's. */
export function defaultContractRefs(): ContractRef[] {
  const refs = [
    ...Object.values(CURRENT_CONTRACTS.byTemplate).flatMap((kinds) => Object.values(kinds)),
    ...Object.values(CURRENT_CONTRACTS.generic),
    ...Object.values(LIVE_FINDING_VERIFY)
  ]
  return [...new Set(refs)].sort()
}

/**
 * Default contracts that may still run without a calibration. A RATCHET: each entry must stay
 * uncalibrated or measured, so a calibration forces its removal. Phase 7 is done when it is empty.
 */
export const UNCALIBRATED_ALLOWED: readonly ContractRef[] = [
  'council-final-check@1',
  'council-peer-rank@1',
  'decide-compare-line@1',
  'decide-final-check@1',
  'decide-one-answer@1',
  'decide-shortlist@1',
  'discover-set-aside@1',
  'discover-verify@1',
  'discover-verify@3',
  'find-final@1',
  'find-screen@2',
  'generic-criterion-line@1',
  'generic-final-check@1',
  'generic-finding-verify@1',
  'generic-finding-verify@3',
  'generic-hard-limit-gate@1',
  'generic-one-answer-route@1',
  'generic-rank-ballot@1',
  'generic-screen-order@2',
  'generic-set-aside-gate@1',
  'improve-judge@1'
]

const PAIR_TRUTHS: readonly GoldenTruth[] = ['a', 'b']
const YES_NO_TRUTHS: readonly GoldenTruth[] = ['yes', 'no']

export function contractCalibration(
  ref: ContractRef,
  evidence: CalibrationEvidence
): CalibrationState {
  const { file, current } = evidence
  if (!file) {
    return 'uncalibrated'
  }
  if (
    file.contract !== ref ||
    file.contractDigest !== current.contractDigest ||
    file.jevModel !== current.jevModel ||
    !current.golden ||
    file.goldenDigest !== current.golden.digest
  ) {
    return 'stale'
  }
  const contract = contractByRef(ref)
  // Recomputed, never read from the file: a hand-edited summary cannot calibrate a contract.
  const summary = summarizeCalibration(contract, file.rows)
  const known = file.rows.filter((row) => row.agree !== null).length
  const sides = file.rows.some((row) => row.truth === 'a' || row.truth === 'b')
    ? PAIR_TRUTHS
    : YES_NO_TRUTHS
  const thinSide = sides.some((side) => (summary.truths[side] ?? 0) < MIN_ITEMS_PER_SIDE)
  const reviewed = current.golden.status === 'reviewed' && !!current.golden.reviewedBy?.trim()
  if (!reviewed || known < contract.target.minItems || thinSide) {
    return 'measured'
  }
  return summary.confident.upper > contract.target.maxConfidentDisagreement
    ? 'failing'
    : 'calibrated'
}

/** Why a default naming a contract that `replaces` another breaks the switch rule; empty when it holds. */
export function switchRuleProblems(
  contract: DecisionContract,
  files: { next?: CalibrationFile; previous?: CalibrationFile },
  valid: (file: CalibrationFile) => boolean
): string[] {
  const { replaces } = contract
  if (!replaces) {
    return []
  }
  const ref = contractRefOf(contract)
  const { next, previous } = files
  if (!next || !valid(next) || !previous || !valid(previous)) {
    return [`${ref} replaces ${replaces}: both need a valid calibration file`]
  }
  if (next.goldenDigest !== previous.goldenDigest) {
    return [`${ref} and ${replaces} were calibrated on different golden sets`]
  }
  // Recomputed from the rows, never read from either file's summary.
  const now = summarizeCalibration(contract, next.rows)
  const before = summarizeCalibration(contractByRef(replaces), previous.rows)
  const problems: string[] = []
  if ((now.accuracy ?? 0) < (before.accuracy ?? 0)) {
    problems.push(`${ref} is less accurate than ${replaces}`)
  }
  if (now.costly.upper > before.costly.upper) {
    problems.push(`${ref} has a higher costly-side error bound than ${replaces}`)
  }
  if (now.confident.upper > contract.target.maxConfidentDisagreement) {
    problems.push(`${ref}'s confident-disagreement bound is above its target`)
  }
  return problems
}

/** Why the uncalibrated list no longer holds; empty when every default is calibrated or allowed. */
export function ratchetProblems(
  states: Readonly<Record<string, CalibrationState>>,
  allowed: readonly ContractRef[] = UNCALIBRATED_ALLOWED,
  defaults: readonly ContractRef[] = defaultContractRefs()
): string[] {
  const problems: string[] = []
  for (const ref of allowed) {
    if (!defaults.includes(ref)) {
      problems.push(`${ref} is allowed uncalibrated but no default names it: remove it`)
    }
    const state = states[ref] ?? 'uncalibrated'
    if (state !== 'uncalibrated' && state !== 'measured') {
      problems.push(`${ref} is ${state}: remove it from UNCALIBRATED_ALLOWED`)
    }
  }
  for (const ref of defaults) {
    const state = states[ref] ?? 'uncalibrated'
    if (!allowed.includes(ref) && state !== 'calibrated') {
      problems.push(`${ref} is a default but ${state}`)
    }
  }
  return problems
}
