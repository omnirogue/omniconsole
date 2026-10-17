import type { CalibrationFile } from './decision-calibration-summary'
import type { CalibrationEvidence } from './decision-contract-calibration'
import type { ContractRef } from './decision-contract-types'
import { JEV_MODEL } from '../jev-confidence'

/** A calibration file committed under calibration/, with its golden set as it stood at that commit. */
export type CommittedCalibration = {
  file: CalibrationFile
  golden: NonNullable<CalibrationEvidence['current']['golden']>
}

// The app cannot read the golden folder, so each entry snapshots its set; CI keeps the snapshot current.
export const COMMITTED_CALIBRATIONS: readonly CommittedCalibration[] = []

/** What the app judges a contract's calibration against: its committed file, if any, and today's JEV. */
export function calibrationEvidenceFor(
  ref: ContractRef,
  committed: readonly CommittedCalibration[] = COMMITTED_CALIBRATIONS
): CalibrationEvidence {
  const entry = committed.find(({ file }) => file.contract === ref)
  return {
    ...(entry ? { file: entry.file } : {}),
    current: {
      // CI refuses a committed file whose contract changed, so its digest is the contract's at every commit.
      contractDigest: entry?.file.contractDigest ?? '',
      jevModel: JEV_MODEL,
      ...(entry ? { golden: entry.golden } : {})
    }
  }
}
