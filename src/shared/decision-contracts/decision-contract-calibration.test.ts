import { describe, expect, it } from 'vitest'
import {
  calibrationBand,
  calibrationRow,
  costlyMiss,
  noulReading,
  pairReading,
  scoreLineReading,
  wilsonUpper,
  type CalibrationRow,
  type GoldenTruth
} from './decision-calibration-rows'
import {
  calibrationFileProblems,
  summarizeCalibration,
  type CalibrationFile
} from './decision-calibration-summary'
import {
  contractCalibration,
  defaultContractRefs,
  ratchetProblems,
  switchRuleProblems,
  UNCALIBRATED_ALLOWED,
  type CalibrationEvidence
} from './decision-contract-calibration'
import { contractByRef } from './decision-contract-library'
import type { ContractRef, DecisionContract } from './decision-contract-types'

const SET_ASIDE = contractByRef('discover-set-aside@1')
const ONE_ANSWER = contractByRef('decide-one-answer@1')
const LINE = contractByRef('decide-compare-line@1')
const tokens = { input: 100, output: 0 }

/** `count` rows JEV decided alone and sure, `misses` of them wrong, over yes and no. */
function yesNoRows(count: number, misses: number, prefix = 'r'): CalibrationRow[] {
  return Array.from({ length: count }, (_, index) => {
    const truth: GoldenTruth = index % 2 ? 'yes' : 'no'
    const wrong = index < misses
    const decision = wrong ? (truth === 'yes' ? 'no' : 'yes') : truth
    return calibrationRow(
      `${prefix}${index}`,
      truth,
      { decision, probability: 0.95, unsure: false },
      tokens
    )
  })
}

function fileOf(ref: ContractRef, rows: CalibrationRow[], golden = 'g'): CalibrationFile {
  return {
    contract: ref,
    contractDigest: `digest-${ref}`,
    golden: { set: 'set', version: 1 },
    goldenDigest: golden,
    jevModel: 'jev-1.13.0',
    commit: 'abc',
    command: 'test',
    ranAt: '2026-09-24T00:00:00.000Z',
    rows,
    summary: summarizeCalibration(contractByRef(ref), rows)
  }
}

const reviewed = (ref: ContractRef): CalibrationEvidence['current'] => ({
  contractDigest: `digest-${ref}`,
  jevModel: 'jev-1.13.0',
  golden: { digest: 'g', status: 'reviewed', reviewedBy: 'A person' }
})

describe('the Wilson 95% upper bound', () => {
  it('is 3.84/(n+3.84) with no misses, so a 5% target needs 73 confident items', () => {
    expect(wilsonUpper(0, 73)).toBeCloseTo(3.8415 / (73 + 3.8415), 4)
    expect(wilsonUpper(0, 73)).toBeLessThan(0.05)
    expect(wilsonUpper(0, 72)).toBeGreaterThan(0.05)
  })

  it('matches the textbook values and is 1 with no evidence', () => {
    expect(wilsonUpper(5, 100)).toBeCloseTo(0.11175, 4)
    expect(wilsonUpper(1, 10)).toBeCloseTo(0.40415, 4)
    expect(wilsonUpper(0, 0)).toBe(1)
    expect(wilsonUpper(10, 10)).toBeCloseTo(1, 10)
  })
})

describe('bands for each policy method', () => {
  it('noul: unsure inside the band, both ends included, else sure of its side', () => {
    const policy = ONE_ANSWER.confidence as Extract<
      DecisionContract['confidence'],
      { method: 'noul' }
    >
    expect(noulReading(policy, 0.95)).toEqual({ decision: 'yes', probability: 0.95, unsure: false })
    expect(calibrationBand(noulReading(policy, 0.95))).toBe('sure')
    expect(calibrationBand(noulReading(policy, 0.65))).toBe('unsure')
    expect(calibrationBand(noulReading(policy, 0.35))).toBe('unsure')
    const no = noulReading(policy, 0.15)
    expect(no.decision).toBe('no')
    expect(calibrationBand(no)).toBe('0.8-0.9')
    expect(calibrationBand(noulReading(policy, 0.7))).toBe('0.65-0.8')
  })

  it('score-line: the decision is the live line; P(level ≥ line) when levels exist', () => {
    const policy = SET_ASIDE.confidence as Extract<
      DecisionContract['confidence'],
      { method: 'score-line' }
    >
    const keep = scoreLineReading(policy, 3, [0.05, 0.05, 0.1, 0.5, 0.3])
    expect(keep).toMatchObject({ decision: 'yes', unsure: false })
    expect(calibrationBand(keep)).toBe('sure')
    const setAside = scoreLineReading(policy, 0.4, [0.7, 0.2, 0.1, 0, 0])
    expect(setAside.decision).toBe('no')
    expect(calibrationBand(setAside)).toBe('0.65-0.8')
    // No levels: the decision stands, but its band is unknown rather than guessed.
    const bare = scoreLineReading(policy, 3)
    expect(calibrationBand(bare)).toBe('unknown')
    expect(calibrationRow('x', 'yes', bare, null)).toMatchObject({ alone: true, agree: true })
  })

  it('pairwise and auto: P(b) is the mean of both orders; the ranker’s unsure call wins', () => {
    const pairs = [
      { first: 'a', second: 'b', probability: 0.2 },
      { first: 'b', second: 'a', probability: 0.9 }
    ]
    const reading = pairReading('b', false, pairs)
    expect(reading.decision).toBe('b')
    expect(reading.probability!).toBeCloseTo(0.85, 10)
    expect(calibrationBand(pairReading('b', false, pairs))).toBe('0.8-0.9')
    expect(calibrationBand(pairReading('a', true, pairs))).toBe('unsure')
    // Auto over rubric scores has no pair probability: only its unsure call.
    expect(calibrationBand({ decision: 'a', probability: null, unsure: true })).toBe('unsure')
    expect(calibrationBand({ failed: 'JEV answered overloaded' })).toBe('unknown')
    expect(calibrationBand({ decision: 'a', probability: 0.55, unsure: false })).toBe('low')
  })
})

describe('the costly side', () => {
  it('follows harm: set-aside wrongly drops a real item; one-answer wrongly routes; symmetric counts both', () => {
    expect(costlyMiss(SET_ASIDE, 'no', 'yes')).toBe(true)
    expect(costlyMiss(SET_ASIDE, 'yes', 'no')).toBe(false)
    expect(costlyMiss(ONE_ANSWER, 'yes', 'no')).toBe(true)
    expect(costlyMiss(ONE_ANSWER, 'no', 'yes')).toBe(false)
    expect(costlyMiss(LINE, 'a', 'b')).toBe(true)
    expect(costlyMiss(LINE, 'b', 'a')).toBe(true)
    expect(costlyMiss(contractByRef('council-final-check@1'), 'b', 'a')).toBe(true)
    expect(costlyMiss(contractByRef('council-final-check@1'), 'a', 'b')).toBe(false)
  })
})

describe('the summary', () => {
  it('recomputes bands, escalation, accuracy and both bounds from the rows', () => {
    const rows = [
      ...yesNoRows(20, 2),
      calibrationRow('u1', 'yes', { decision: 'yes', probability: 0.6, unsure: true }, tokens),
      calibrationRow('u2', 'no', { failed: 'overloaded' }, null),
      calibrationRow('u3', 'unknown', { decision: 'yes', probability: 0.95, unsure: false }, tokens)
    ]
    const summary = summarizeCalibration(SET_ASIDE, rows)
    expect(summary.n).toBe(23)
    expect(summary.truths).toEqual({ no: 11, yes: 11, unknown: 1 })
    expect(summary.escalationShare).toBeCloseTo(2 / 23, 5)
    expect(summary.accuracy).toBeCloseTo(19 / 21, 5)
    expect(summary.confident).toMatchObject({ n: 20, misses: 2, rate: 0.1 })
    // Rows 0 and 1: truth no read yes (not costly for set-aside), truth yes read no (costly).
    expect(summary.costly).toMatchObject({ n: 20, misses: 1 })
    const sure = summary.bands.find((band) => band.band === 'sure')!
    expect(sure).toMatchObject({ n: 21, known: 20, agree: 18, disagreeRate: 0.1 })
    expect(summary.bands.find((band) => band.band === 'unknown')).toMatchObject({
      n: 1,
      tokens: 'unknown'
    })
    expect(summary.tokens).toBe('unknown')
  })

  it('finds a tampered summary, a tampered row and changed labels', () => {
    const rows = yesNoRows(4, 1)
    const golden = rows.map(({ id, truth }) => ({ id, truth }))
    const file = fileOf('discover-set-aside@1', rows)
    expect(calibrationFileProblems(file, SET_ASIDE, golden)).toEqual([])
    const summary = { ...file.summary, accuracy: 1 }
    expect(calibrationFileProblems({ ...file, summary }, SET_ASIDE, golden)).toEqual([
      'the summary does not recompute from the rows'
    ])
    const flipped = rows.map((row, index) => (index ? row : { ...row, agree: true }))
    expect(calibrationFileProblems({ ...file, rows: flipped }, SET_ASIDE, golden)).toContain(
      'row r0 does not recompute from its decision, probability and truth'
    )
    const relabelled = golden.map((item, index) =>
      index ? item : { ...item, truth: 'yes' as const }
    )
    expect(calibrationFileProblems(file, SET_ASIDE, relabelled)).toContain(
      "the rows are not the golden set's items and labels, in order"
    )
  })
})

describe('contractCalibration', () => {
  const ref = 'discover-set-aside@1'
  it('is uncalibrated without a file and stale when anything it was measured on changed', () => {
    const file = fileOf(ref, yesNoRows(80, 0))
    expect(contractCalibration(ref, { current: reviewed(ref) })).toBe('uncalibrated')
    expect(contractCalibration(ref, { file, current: reviewed(ref) })).toBe('calibrated')
    const current = reviewed(ref)
    for (const changed of [
      { ...current, contractDigest: 'other' },
      { ...current, jevModel: 'jev-2.0.0' },
      { ...current, golden: { ...current.golden!, digest: 'other' } },
      { contractDigest: current.contractDigest, jevModel: current.jevModel }
    ]) {
      expect(contractCalibration(ref, { file, current: changed })).toBe('stale')
    }
    expect(contractCalibration('decide-shortlist@1', { file, current })).toBe('stale')
  })

  it('is measured on an unreviewed set, too few items, or a thin side', () => {
    const current = reviewed(ref)
    const skeleton = { ...current, golden: { digest: 'g', status: 'skeleton' as const } }
    expect(
      contractCalibration(ref, { file: fileOf(ref, yesNoRows(80, 0)), current: skeleton })
    ).toBe('measured')
    const unsigned = {
      ...current,
      golden: { digest: 'g', status: 'reviewed' as const, reviewedBy: ' ' }
    }
    expect(
      contractCalibration(ref, { file: fileOf(ref, yesNoRows(80, 0)), current: unsigned })
    ).toBe('measured')
    expect(contractCalibration(ref, { file: fileOf(ref, yesNoRows(79, 0)), current })).toBe(
      'measured'
    )
    const oneSided = Array.from({ length: 90 }, (_, index) =>
      calibrationRow(
        `y${index}`,
        index < 82 ? 'yes' : 'no',
        { decision: index < 82 ? 'yes' : 'no', probability: 0.95, unsure: false },
        tokens
      )
    )
    expect(contractCalibration(ref, { file: fileOf(ref, oneSided), current })).toBe('measured')
  })

  it('is failing when the confident-disagreement bound is above target', () => {
    expect(
      contractCalibration(ref, { file: fileOf(ref, yesNoRows(100, 1)), current: reviewed(ref) })
    ).toBe('failing')
    expect(
      contractCalibration(ref, { file: fileOf(ref, yesNoRows(200, 1)), current: reviewed(ref) })
    ).toBe('calibrated')
  })
})

describe('the switch rule', () => {
  const next: DecisionContract = { ...SET_ASIDE, version: 99, replaces: 'discover-set-aside@1' }
  const valid = () => true
  const good = fileOf('discover-set-aside@1', yesNoRows(200, 0))
  const baseline = fileOf('discover-set-aside@1', yesNoRows(200, 2))

  it('holds only with both files valid on one golden set, as accurate, as safe and within target', () => {
    expect(switchRuleProblems(SET_ASIDE, {}, valid)).toEqual([])
    expect(switchRuleProblems(next, { next: good, previous: baseline }, valid)).toEqual([])
    expect(switchRuleProblems(next, { next: good }, valid)).toEqual([
      'discover-set-aside@99 replaces discover-set-aside@1: both need a valid calibration file'
    ])
    expect(switchRuleProblems(next, { next: good, previous: baseline }, () => false)).toHaveLength(
      1
    )
    const elsewhere = { ...good, goldenDigest: 'other' }
    expect(switchRuleProblems(next, { next: elsewhere, previous: baseline }, valid)).toEqual([
      'discover-set-aside@99 and discover-set-aside@1 were calibrated on different golden sets'
    ])
  })

  it('refuses a switch that is less accurate, less safe or above target, recomputed from the rows', () => {
    const worse = fileOf('discover-set-aside@1', yesNoRows(200, 12))
    expect(switchRuleProblems(next, { next: worse, previous: baseline }, valid)).toEqual([
      'discover-set-aside@99 is less accurate than discover-set-aside@1',
      'discover-set-aside@99 has a higher costly-side error bound than discover-set-aside@1',
      "discover-set-aside@99's confident-disagreement bound is above its target"
    ])
    // A summary that claims better numbers than its rows is ignored.
    const claims = { ...worse, summary: good.summary }
    expect(switchRuleProblems(next, { next: claims, previous: baseline }, valid)).toHaveLength(3)
  })
})

describe('the uncalibrated ratchet', () => {
  it('lists every default contract today, and nothing else', () => {
    expect([...UNCALIBRATED_ALLOWED].sort()).toEqual(defaultContractRefs())
    expect(ratchetProblems({})).toEqual([])
  })

  it('forces an entry off the list once it is calibrated, stale or failing', () => {
    expect(ratchetProblems({ 'discover-set-aside@1': 'measured' })).toEqual([])
    for (const state of ['calibrated', 'stale', 'failing'] as const) {
      expect(ratchetProblems({ 'discover-set-aside@1': state })).toEqual([
        `discover-set-aside@1 is ${state}: remove it from UNCALIBRATED_ALLOWED`
      ])
    }
  })

  it('fails when an entry is removed while the contract is still uncalibrated or measured', () => {
    const without = UNCALIBRATED_ALLOWED.filter((ref) => ref !== 'decide-one-answer@1')
    expect(ratchetProblems({}, without)).toEqual([
      'decide-one-answer@1 is a default but uncalibrated'
    ])
    expect(ratchetProblems({ 'decide-one-answer@1': 'measured' }, without)).toEqual([
      'decide-one-answer@1 is a default but measured'
    ])
    expect(ratchetProblems({ 'decide-one-answer@1': 'calibrated' }, without)).toEqual([])
  })

  it('fails on an entry no default names', () => {
    expect(ratchetProblems({}, [...UNCALIBRATED_ALLOWED, 'find-screen@1'])).toEqual([
      'find-screen@1 is allowed uncalibrated but no default names it: remove it'
    ])
  })
})
