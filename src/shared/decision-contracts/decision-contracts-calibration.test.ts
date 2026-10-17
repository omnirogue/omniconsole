import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JEV_MODEL } from '../jev-confidence'
import type { GoldenTruth } from './decision-calibration-rows'
import {
  calibrationFileProblems,
  canonicalJson,
  type CalibrationFile
} from './decision-calibration-summary'
import {
  contractCalibration,
  defaultContractRefs,
  ratchetProblems,
  switchRuleProblems,
  type CalibrationState
} from './decision-contract-calibration'
import { contractByRef } from './decision-contract-library'
import type { ContractRef } from './decision-contract-types'

// CI: committed calibrations must still hold, and the uncalibrated list may only shrink.

const CALIBRATION_DIR = join(__dirname, 'calibration')
const FIXTURE_DIR = join(__dirname, '__fixtures__', 'calibration')
const GOLDEN_DIR = join(__dirname, '../../../config/scripts/workflows/benchmark/golden')
const digests = JSON.parse(
  readFileSync(join(__dirname, 'decision-contract-digests.json'), 'utf8')
) as Record<string, string>

type Golden = {
  status: 'skeleton' | 'reviewed'
  reviewedBy: string | null
  items: { id: string; truth: GoldenTruth }[]
}

type Calibrations = {
  files: Map<ContractRef, CalibrationFile>
  states: Record<string, CalibrationState>
  problems: string[]
}

/** Every calibration file in a folder, each checked against today's contract, golden set and JEV model. */
function readCalibrations(dir: string, jevModel = JEV_MODEL): Calibrations {
  const found: Calibrations = { files: new Map(), states: {}, problems: [] }
  const names = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.json')) : []
  for (const name of names) {
    const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as CalibrationFile
    const ref = file.contract
    if (name !== `${ref.replace('@', '.v')}.json`) {
      found.problems.push(`${name} holds ${ref}: name it ${ref.replace('@', '.v')}.json`)
      continue
    }
    const goldenPath = join(GOLDEN_DIR, file.golden.set, `v${file.golden.version}.json`)
    const golden = existsSync(goldenPath)
      ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Golden)
      : undefined
    const state = contractCalibration(ref, {
      file,
      current: {
        contractDigest: digests[ref] ?? 'unpublished',
        jevModel,
        ...(golden
          ? {
              golden: {
                digest: createHash('sha256').update(canonicalJson(golden)).digest('hex'),
                status: golden.status,
                ...(golden.reviewedBy ? { reviewedBy: golden.reviewedBy } : {})
              }
            }
          : {})
      }
    })
    found.files.set(ref, file)
    found.states[ref] = state
    if (state === 'stale') {
      found.problems.push(`${name} is stale: its contract, golden set or JEV model changed`)
      continue
    }
    found.problems.push(
      ...calibrationFileProblems(file, contractByRef(ref), golden!.items).map(
        (problem) => `${name}: ${problem}`
      )
    )
  }
  return found
}

describe('committed calibrations', () => {
  const committed = readCalibrations(CALIBRATION_DIR)

  it('are all current and recompute from their rows', () => {
    expect(committed.problems).toEqual([])
  })

  it('keep the uncalibrated list a ratchet over every default contract', () => {
    expect(ratchetProblems(committed.states)).toEqual([])
  })

  it('let a default replace another contract only under the switch rule', () => {
    const valid = (file: CalibrationFile) => committed.states[file.contract] !== 'stale'
    for (const ref of defaultContractRefs()) {
      const contract = contractByRef(ref)
      const files = {
        next: committed.files.get(ref),
        previous: contract.replaces ? committed.files.get(contract.replaces) : undefined
      }
      expect(switchRuleProblems(contract, files, valid)).toEqual([])
    }
  })
})

describe('the calibration check itself (on a test fixture from a fake JEV)', () => {
  it('reads the fixture as measured: its golden set is an unreviewed skeleton', () => {
    const fixture = readCalibrations(FIXTURE_DIR)
    expect(fixture.problems).toEqual([])
    expect(fixture.states).toEqual({ 'discover-set-aside@1': 'measured' })
    // Measured stays allowed; the same file on a reviewed, large set would force removal.
    expect(ratchetProblems(fixture.states)).toEqual([])
  })

  it('fails a file measured on another JEV model', () => {
    const fixture = readCalibrations(FIXTURE_DIR, 'jev-9.9.9')
    expect(fixture.states['discover-set-aside@1']).toBe('stale')
    expect(fixture.problems).toEqual([
      'discover-set-aside.v1.json is stale: its contract, golden set or JEV model changed'
    ])
  })

  it('fails a file whose summary was edited by hand', () => {
    const file = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'discover-set-aside.v1.json'), 'utf8')
    ) as CalibrationFile
    const golden = JSON.parse(
      readFileSync(join(GOLDEN_DIR, 'discover-set-aside', 'v1.json'), 'utf8')
    ) as Golden
    const contract = contractByRef('discover-set-aside@1')
    expect(calibrationFileProblems(file, contract, golden.items)).toEqual([])
    const edited = { ...file, summary: { ...file.summary, accuracy: 1 } }
    expect(calibrationFileProblems(edited, contract, golden.items)).toEqual([
      'the summary does not recompute from the rows'
    ])
  })
})
