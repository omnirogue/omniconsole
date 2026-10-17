import { summarizeCalibration } from './decision-calibration-summary'
import { calibrationEvidenceFor } from './decision-calibration-registry'
import {
  contractCalibration,
  type CalibrationEvidence,
  type CalibrationState
} from './decision-contract-calibration'
import { contractByRef } from './decision-contract-library'
import type { ContractRef, UnknownOutcome } from './decision-contract-types'

/** How far a decision's rule has been checked, in the words the UI uses. */
export type JudgeCheckState = 'checked' | 'too-few' | 'failing' | 'not-yet' | 'stale'

/** One JEV decision point of a run and how far its rule has been checked against known answers. */
export type DecisionContractCheck = {
  point: string
  ref: ContractRef
  state: JudgeCheckState
  /** Known answers the rule was checked against; absent when it never was, or the check no longer counts. */
  count?: number
  /** Of the answers JEV gave when sure, the percentage that agreed with the known answer. */
  agree?: number
  /** Percentage of known answers JEV was unsure about, or gave no answer to. */
  unsure?: number
  fallback: UnknownOutcome
}

const STATE_WORDS: Record<CalibrationState, JudgeCheckState> = {
  calibrated: 'checked',
  measured: 'too-few',
  failing: 'failing',
  uncalibrated: 'not-yet',
  stale: 'stale'
}

const percent = (share: number | null) => (share === null ? undefined : Math.round(share * 100))

export function decisionContractCheck(
  point: string,
  ref: ContractRef,
  evidence: CalibrationEvidence = calibrationEvidenceFor(ref)
): DecisionContractCheck {
  const contract = contractByRef(ref)
  const state = STATE_WORDS[contractCalibration(ref, evidence)]
  const check: DecisionContractCheck = { point, ref, state, fallback: contract.unknown.fallback }
  if (state === 'not-yet' || state === 'stale' || !evidence.file) {
    return check
  }
  // Recomputed from the rows, like the state: a file's own summary is never shown.
  const summary = summarizeCalibration(contract, evidence.file.rows)
  const agree = percent(summary.confident.rate)
  const unsure = percent(summary.escalationShare)
  return {
    ...check,
    count: evidence.file.rows.filter((row) => row.agree !== null).length,
    ...(agree === undefined ? {} : { agree: 100 - agree }),
    ...(unsure === undefined ? {} : { unsure })
  }
}
