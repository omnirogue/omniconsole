import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JevRanking, JevScreen } from '../../../../src/main/structured-decisions/jev-rank'
import { calibrationFileProblems } from '../../../../src/shared/decision-contracts/decision-calibration-summary'
import { contractCalibration } from '../../../../src/shared/decision-contracts/decision-contract-calibration'
import { contractByRef } from '../../../../src/shared/decision-contracts/decision-contract-library'
import { JEV_MODEL } from '../../../../src/shared/jev-confidence'
import type { DecisionResult } from '../../../../src/shared/structured-decisions'
import { calibrateContractCommand, MISSING_KEY, type CalibrateDeps } from './calibrate-contract'
import {
  calibrateContract,
  contractDigest,
  goldenDigest,
  latestGoldenPath,
  readGolden,
  type CalibrationJev
} from './contract-calibration'

const KIT_DIR = import.meta.dirname
const usage = { inputTokens: 1_000, outputTokens: 0 }
const golden = (set: string) => readGolden(latestGoldenPath(KIT_DIR, set)!)

/** A fake JEV: the screen passes everything but the loose-equality decoy; NOUL and pairs follow the text. */
function fakeJev(): CalibrationJev {
  return {
    screen: vi.fn(async (request): Promise<JevScreen> => {
      const low = request.candidates[0]!.text.includes('Loose equality')
      return {
        model: JEV_MODEL,
        scores: { item: low ? 0 : 3 },
        certainty: {
          item: { confidence: 0.9, levels: low ? [0.9, 0.1, 0, 0, 0] : [0, 0.05, 0.05, 0.6, 0.3] }
        },
        criteria: [],
        unscored: [],
        retryableUnscored: [],
        usage,
        calls: 1
      }
    }),
    decide: vi.fn(async (request): Promise<DecisionResult> => {
      const question = String((request.state as { question: string }).question)
      return {
        provider: 'typesafe',
        model: JEV_MODEL,
        answers: {
          yes: { type: 'noul', noul: /how many|what does|which/i.test(question) ? 0.92 : 0.5 }
        },
        usage
      }
    }),
    rank: vi.fn(async (request): Promise<JevRanking> => {
      expect(request.policy).toEqual(contractByRef('decide-compare-line@1').confidence)
      const longer = request.candidates[1]!.text.length > request.candidates[0]!.text.length
      return {
        method: 'pairwise',
        model: JEV_MODEL,
        order: longer ? ['b', 'a'] : ['a', 'b'],
        scores: {},
        criteria: [],
        pairs: [
          { first: 'a', second: 'b', probability: longer ? 0.1 : 0.9 },
          { first: 'b', second: 'a', probability: longer ? 0.9 : 0.1 }
        ],
        usage,
        unsure: false,
        calls: 2
      }
    })
  }
}

describe('calibrateContract', () => {
  it('judges a score-line gate through jevScreen with the stored task, rubric and item', async () => {
    const jev = fakeJev()
    const set = golden('discover-set-aside')
    const rows = await calibrateContract(contractByRef('discover-set-aside@1'), set, jev)
    expect(jev.screen).toHaveBeenCalledTimes(15)
    expect(vi.mocked(jev.screen).mock.calls[0]![0]).toMatchObject({
      task: set.items[0]!.state.task,
      rubric: set.items[0]!.state.rubric,
      candidates: [{ id: 'item', text: set.items[0]!.state.text }]
    })
    expect(rows.find((row) => row.id === 'D03')).toMatchObject({
      decision: 'no',
      agree: true,
      band: 'sure'
    })
    expect(rows.find((row) => row.id === 'D01')).toMatchObject({ decision: 'yes', agree: false })
    expect(rows.every((row) => row.tokens?.input === 1_000)).toBe(true)
  })

  it('asks a NOUL route its contract question and reads the band', async () => {
    const jev = fakeJev()
    const rows = await calibrateContract(
      contractByRef('decide-one-answer@1'),
      golden('decide-one-answer'),
      jev
    )
    const question = contractByRef('decide-one-answer@1').confidence as { question: string }
    expect(vi.mocked(jev.decide).mock.calls[0]![0].questions).toEqual({
      yes: { type: 'noul', instructions: question.question }
    })
    expect(
      rows.filter((row) => row.band === 'unsure').length +
        rows.filter((row) => row.band === 'sure').length
    ).toBe(10)
  })

  it('ranks a pair with the contract policy and P(b) from both orders', async () => {
    const rows = await calibrateContract(
      contractByRef('decide-compare-line@1'),
      golden('decide-compare-line'),
      fakeJev()
    )
    expect(rows).toHaveLength(10)
    expect(
      rows.every((row) => row.probability !== null && Math.abs(row.probability - 0.9) < 1e-9)
    ).toBe(true)
  })

  it('keeps a failed item as unknown and refuses what it cannot calibrate', async () => {
    const jev = { ...fakeJev(), decide: async () => ({ failed: 'JEV answered overloaded' }) }
    const rows = await calibrateContract(
      contractByRef('decide-one-answer@1'),
      golden('decide-one-answer'),
      jev
    )
    expect(rows[0]).toMatchObject({
      decision: null,
      band: 'unknown',
      alone: false,
      failed: 'JEV answered overloaded'
    })
    await expect(
      calibrateContract(contractByRef('find-screen@2'), golden('decide-one-answer'), jev)
    ).rejects.toThrow(/only orders options/)
    await expect(
      calibrateContract(contractByRef('decide-one-answer@1'), golden('decide-compare-line'), jev)
    ).rejects.toThrow(/labelled b/)
  })
})

describe('calibrate-contract', () => {
  const folders: string[] = []
  afterEach(() =>
    folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }))
  )
  const scratch = () => {
    const folder = mkdtempSync(join(tmpdir(), 'calibrate-'))
    folders.push(folder)
    return folder
  }
  const deps = (env: NodeJS.ProcessEnv, jev?: CalibrationJev): CalibrateDeps => ({
    env,
    kitDir: KIT_DIR,
    ...(jev ? { jev } : {}),
    commit: async () => 'test-commit',
    now: () => new Date('2026-09-24T00:00:00Z'),
    log: () => {}
  })

  it('refuses without TYPESAFE_API_KEY, before asking JEV or writing anything', async () => {
    const out = join(scratch(), 'out')
    const jev = fakeJev()
    for (const env of [{}, { TYPESAFE_API_KEY: '  ' }]) {
      await expect(
        calibrateContractCommand(
          ['--contract', 'decide-one-answer@1', '--out', out],
          deps(env, jev)
        )
      ).rejects.toThrow(MISSING_KEY)
    }
    expect(jev.decide).not.toHaveBeenCalled()
    expect(existsSync(out)).toBe(false)
  })

  it('refuses an existing out folder', async () => {
    await expect(
      calibrateContractCommand(
        ['--contract', 'decide-one-answer@1', '--out', scratch()],
        deps({ TYPESAFE_API_KEY: 'test-only-not-a-key' }, fakeJev())
      )
    ).rejects.toThrow(/already exists/)
  })

  it('writes a calibration file that recomputes and reads as measured on a skeleton set', async () => {
    const out = join(scratch(), 'out')
    await calibrateContractCommand(
      ['--contract', 'discover-set-aside@1', '--out', out],
      deps({ TYPESAFE_API_KEY: 'test-only-not-a-key' }, fakeJev())
    )
    const file = JSON.parse(readFileSync(join(out, 'discover-set-aside.v1.json'), 'utf8'))
    const set = golden('discover-set-aside')
    const contract = contractByRef('discover-set-aside@1')
    expect(file).toMatchObject({
      contract: 'discover-set-aside@1',
      contractDigest: contractDigest(contract),
      goldenDigest: goldenDigest(set),
      jevModel: JEV_MODEL,
      commit: 'test-commit',
      command: 'calibrate-contract.ts --contract discover-set-aside@1 --out <out>'
    })
    expect(calibrationFileProblems(file, contract, set.items)).toEqual([])
    const current = {
      contractDigest: contractDigest(contract),
      jevModel: JEV_MODEL,
      golden: { digest: goldenDigest(set), status: set.status }
    }
    expect(contractCalibration('discover-set-aside@1', { file, current })).toBe('measured')
    expect(readFileSync(join(out, 'report.md'), 'utf8')).toMatch(/Wilson 95% upper/)
  })

  it('refuses to write when JEV decided nothing', async () => {
    const out = join(scratch(), 'out')
    const jev = {
      ...fakeJev(),
      decide: async () => ({ failed: 'no TypeSafe API key (TYPESAFE_API_KEY)' })
    }
    await expect(
      calibrateContractCommand(
        ['--contract', 'decide-one-answer@1', '--out', out],
        deps({ TYPESAFE_API_KEY: 'test-only-not-a-key' }, jev)
      )
    ).rejects.toThrow(/JEV decided no item/)
    expect(existsSync(out)).toBe(false)
  })
})
