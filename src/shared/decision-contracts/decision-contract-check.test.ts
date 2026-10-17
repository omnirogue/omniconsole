import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JEV_MODEL } from '../jev-confidence'
import { calibrationRow, type JevReading } from './decision-calibration-rows'
import type { CalibrationFile } from './decision-calibration-summary'
import { calibrationEvidenceFor, type CommittedCalibration } from './decision-calibration-registry'
import { decisionContractCheck } from './decision-contract-check'
import type { CalibrationEvidence } from './decision-contract-calibration'

const fixture = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'calibration', 'discover-set-aside.v1.json'), 'utf8')
) as CalibrationFile

const GOLDEN = { digest: fixture.goldenDigest, status: 'reviewed', reviewedBy: 'A person' } as const

/** A gate checked on `n` items per side; the first `wrong` of each side JEV got wrong while sure. */
function gateFile(n: number, wrong: number, unsure = 0): CalibrationFile {
  const rows = (['yes', 'no'] as const).flatMap((truth) =>
    Array.from({ length: n }, (_, index) => {
      const miss = index < wrong
      const reading: JevReading = {
        decision: miss === (truth === 'yes') ? 'no' : 'yes',
        probability: 0.95,
        unsure: index >= wrong && index < wrong + unsure
      }
      return calibrationRow(`${truth}-${index}`, truth, reading, null)
    })
  )
  return { ...fixture, rows }
}

const evidence = (
  file: CalibrationFile,
  golden: CalibrationEvidence['current']['golden'] = GOLDEN
): CalibrationEvidence => ({
  file,
  current: { contractDigest: file.contractDigest, jevModel: JEV_MODEL, golden }
})

describe('decisionContractCheck', () => {
  it('reads a contract with no committed file as not yet checked, with its fallback', () => {
    expect(decisionContractCheck('route', 'decide-one-answer@1')).toEqual({
      point: 'route',
      ref: 'decide-one-answer@1',
      state: 'not-yet',
      fallback: 'full-workflow'
    })
  })

  it('reads the fixture, measured on an unreviewed set, as too few, with its counts', () => {
    const check = decisionContractCheck(
      'r/set-aside',
      'discover-set-aside@1',
      evidence(fixture, { digest: fixture.goldenDigest, status: 'skeleton' })
    )
    expect(check).toEqual({
      point: 'r/set-aside',
      ref: 'discover-set-aside@1',
      state: 'too-few',
      count: 14,
      agree: 86,
      unsure: 7,
      fallback: 'keep-and-verify'
    })
  })

  it('reads a large reviewed check as checked, agreement and unsure shares rounded', () => {
    const check = decisionContractCheck(
      'r/set-aside',
      'discover-set-aside@1',
      evidence(gateFile(50, 0, 4))
    )
    expect(check).toMatchObject({ state: 'checked', count: 100, agree: 100, unsure: 8 })
  })

  it('reads too many confident misses as failing', () => {
    const check = decisionContractCheck(
      'r/set-aside',
      'discover-set-aside@1',
      evidence(gateFile(50, 10))
    )
    expect(check).toMatchObject({ state: 'failing', count: 100, agree: 80 })
  })

  it('reads a check on another JEV model as stale, without its old numbers', () => {
    const stale = {
      ...evidence(gateFile(50, 1)),
      current: { contractDigest: 'x', jevModel: JEV_MODEL }
    }
    expect(decisionContractCheck('r/set-aside', 'discover-set-aside@1', stale)).toEqual({
      point: 'r/set-aside',
      ref: 'discover-set-aside@1',
      state: 'stale',
      fallback: 'keep-and-verify'
    })
  })

  it("builds evidence from the committed registry and today's JEV model", () => {
    expect(calibrationEvidenceFor('discover-set-aside@1')).toEqual({
      current: { contractDigest: '', jevModel: JEV_MODEL }
    })
    const committed: CommittedCalibration[] = [{ file: fixture, golden: GOLDEN }]
    expect(calibrationEvidenceFor('discover-set-aside@1', committed)).toEqual({
      file: fixture,
      current: { contractDigest: fixture.contractDigest, jevModel: JEV_MODEL, golden: GOLDEN }
    })
    expect(calibrationEvidenceFor('no-such@9', committed).file).toBeUndefined()
  })
})
