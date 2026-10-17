import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decisionNoulBrier } from '../../../../src/main/structured-decisions/decision-experiment-metrics'
import type {
  jevDecide,
  jevRank,
  jevScreen
} from '../../../../src/main/structured-decisions/jev-rank'
import {
  calibrationRow,
  noulReading,
  pairReading,
  scoreLineReading,
  type CalibrationRow,
  type CalibrationTokens,
  type GoldenTruth,
  type JevReading
} from '../../../../src/shared/decision-contracts/decision-calibration-rows'
import {
  canonicalJson,
  summarizeCalibration,
  type CalibrationFile
} from '../../../../src/shared/decision-contracts/decision-calibration-summary'
import {
  contractRefOf,
  type DecisionContract
} from '../../../../src/shared/decision-contracts/decision-contract-types'
import { JEV_MODEL } from '../../../../src/shared/jev-confidence'

/** A frozen labelled set: `state` is exactly what the contract says JEV is shown. */
export type GoldenSet = {
  set: string
  version: number
  frozenAt: string
  status: 'skeleton' | 'reviewed'
  reviewedBy: string | null
  labels: 'key' | 'person' | `frontier:${string}`
  contract?: string
  source?: string
  items: { id: string; truth: GoldenTruth; state: Record<string, string>; source?: string }[]
}

/** The same three JEV calls the live workflow makes; a test injects fakes, the command the real ones. */
export type CalibrationJev = {
  screen: typeof jevScreen
  rank: typeof jevRank
  decide: typeof jevDecide
}

const CAPABILITY = 'benchmark.calibration'

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex')
export const contractDigest = (contract: DecisionContract) => sha256(contract)
export const goldenDigest = (golden: GoldenSet) => sha256(golden)

export function goldenDir(kitDir: string, set: string): string {
  return join(kitDir, 'golden', set)
}

/** The newest frozen version of a set: v<N>.json with the highest N. */
export function latestGoldenPath(kitDir: string, set: string): string | undefined {
  const dir = goldenDir(kitDir, set)
  const versions = existsSync(dir)
    ? readdirSync(dir).flatMap((name) => /^v(\d+)\.json$/.exec(name)?.slice(1) ?? [])
    : []
  const newest = versions.map(Number).sort((a, b) => b - a)[0]
  return newest === undefined ? undefined : join(dir, `v${newest}.json`)
}

export function readGolden(path: string): GoldenSet {
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenSet
}

const orderOnly = (contract: DecisionContract) =>
  new Error(
    `${contractRefOf(contract)} only orders options (method scores): it has no yes/no or pair decision to calibrate`
  )

const PAIR_METHODS: ReadonlySet<string> = new Set(['pairwise', 'auto'])
const PAIR_TRUTHS: ReadonlySet<GoldenTruth> = new Set(['a', 'b', 'tie', 'unknown'])
const YES_NO_TRUTHS: ReadonlySet<GoldenTruth> = new Set(['yes', 'no', 'unknown'])

type Answer = { reading: JevReading; tokens: CalibrationTokens | null }
const tokensOf = (usage?: { inputTokens: number; outputTokens: number }) =>
  usage ? { input: usage.inputTokens, output: usage.outputTokens } : null

async function askNoul(
  jev: CalibrationJev,
  question: string,
  state: Record<string, string>
): Promise<{ p: number; tokens: CalibrationTokens | null } | { failed: string }> {
  const result = await jev.decide({
    capability: CAPABILITY,
    model: JEV_MODEL,
    state,
    questions: { yes: { type: 'noul', instructions: question } }
  })
  if ('failed' in result) {
    return result
  }
  const answer = result.answers.yes
  return answer?.type === 'noul' && Number.isFinite(answer.noul)
    ? { p: answer.noul, tokens: tokensOf(result.usage) }
    : { failed: 'JEV did not answer the question' }
}

/** One golden item through the contract's own policy, the way the live decision asks it. */
async function judgeItem(
  contract: DecisionContract,
  state: Record<string, string>,
  jev: CalibrationJev
): Promise<Answer> {
  const policy = contract.confidence
  switch (policy.method) {
    case 'score-line': {
      const screen = await jev.screen({
        task: state.task ?? '',
        rubric: state.rubric ?? '',
        candidates: [{ id: 'item', text: state.text ?? '' }],
        capability: CAPABILITY
      })
      if ('failed' in screen) {
        return { reading: screen, tokens: null }
      }
      const score = screen.scores.item
      return {
        reading:
          score === undefined
            ? { failed: screen.unscoredReasons?.item ?? 'JEV could not score the item' }
            : scoreLineReading(policy, score, screen.certainty?.item?.levels),
        tokens: tokensOf(screen.usage)
      }
    }
    case 'noul': {
      const first = await askNoul(jev, policy.question, state)
      if ('failed' in first || !policy.bothOrders) {
        return 'failed' in first
          ? { reading: first, tokens: null }
          : { reading: noulReading(policy, first.p), tokens: first.tokens }
      }
      const swapped = {
        ...state,
        response_a: state.response_b ?? '',
        response_b: state.response_a ?? ''
      }
      const second = await askNoul(jev, policy.question, swapped)
      if ('failed' in second) {
        return { reading: second, tokens: null }
      }
      const tokens =
        first.tokens && second.tokens
          ? {
              input: first.tokens.input + second.tokens.input,
              output: first.tokens.output + second.tokens.output
            }
          : null
      return { reading: noulReading(policy, (first.p + 1 - second.p) / 2), tokens }
    }
    case 'pairwise':
    case 'auto': {
      const ranking = await jev.rank({
        method: policy.method,
        task: state.task ?? '',
        rubric: state.rubric ?? '',
        candidates: [
          { id: 'a', text: state.a ?? '' },
          { id: 'b', text: state.b ?? '' }
        ],
        capability: CAPABILITY,
        policy
      })
      if ('failed' in ranking) {
        return { reading: ranking, tokens: null }
      }
      const winner = ranking.order[0] === 'b' ? 'b' : 'a'
      return {
        reading:
          ranking.method === 'pairwise'
            ? pairReading(winner, ranking.unsure, ranking.pairs)
            : { decision: winner, probability: null, unsure: ranking.unsure },
        tokens: tokensOf(ranking.usage)
      }
    }
    case 'scores':
      throw orderOnly(contract)
  }
}

/** Every golden item judged under the contract, in the set's order; a failed item stays as unknown. */
export async function calibrateContract(
  contract: DecisionContract,
  golden: GoldenSet,
  jev: CalibrationJev,
  log: (line: string) => void = () => {}
): Promise<CalibrationRow[]> {
  if (contract.confidence.method === 'scores') {
    throw orderOnly(contract)
  }
  const fits = PAIR_METHODS.has(contract.confidence.method) ? PAIR_TRUTHS : YES_NO_TRUTHS
  const misfit = golden.items.find((item) => !fits.has(item.truth))
  if (misfit) {
    throw new Error(
      `${golden.set} item ${misfit.id} is labelled ${misfit.truth}, which ${contractRefOf(contract)} cannot decide`
    )
  }
  const rows: CalibrationRow[] = []
  for (const item of golden.items) {
    const answer = await judgeItem(contract, item.state, jev)
    const row = calibrationRow(item.id, item.truth, answer.reading, answer.tokens)
    log(
      `${item.id}: ${row.decision ?? 'no decision'} (${row.band})${row.failed ? ` ${row.failed}` : ''}`
    )
    rows.push(row)
  }
  return rows
}

export function calibrationFileOf(input: {
  contract: DecisionContract
  golden: GoldenSet
  rows: CalibrationRow[]
  commit: string
  command: string
  ranAt: string
}): CalibrationFile {
  const { contract, golden, rows } = input
  return {
    contract: contractRefOf(contract),
    contractDigest: contractDigest(contract),
    golden: { set: golden.set, version: golden.version },
    goldenDigest: goldenDigest(golden),
    jevModel: JEV_MODEL,
    commit: input.commit,
    command: input.command,
    ranAt: input.ranAt,
    rows,
    summary: summarizeCalibration(contract, rows)
  }
}

/** Brier score of JEV's probabilities on the known rows, for the report; not part of the committed summary. */
export function calibrationBrier(rows: readonly CalibrationRow[]): number | null {
  const scored = rows.filter((row) => row.agree !== null && row.probability !== null)
  if (!scored.length) {
    return null
  }
  const total = scored.reduce(
    (sum, row) => sum + decisionNoulBrier(row.probability!, row.agree!),
    0
  )
  return total / scored.length
}
