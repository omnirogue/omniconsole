/**
 * Calibrates one decision contract on its frozen golden set with real JEV answers.
 *
 *   npx --yes tsx config/scripts/workflows/benchmark/calibrate-contract.ts \
 *     --contract discover-set-aside@1 --out /tmp/calibrate-set-aside-1 [--golden <v<N>.json>]
 *
 * Needs TYPESAFE_API_KEY. See README.md in this folder ("Calibrating a decision contract").
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DECISION_EXPERIMENT_TARIFF } from '../../../../src/main/structured-decisions/decision-experiment-metrics'
import { jevDecide, jevRank, jevScreen } from '../../../../src/main/structured-decisions/jev-rank'
import { runProcess } from '../../../../src/shared/child-process/run-process'
import type { CalibrationFile } from '../../../../src/shared/decision-contracts/decision-calibration-summary'
import { contractByRef } from '../../../../src/shared/decision-contracts/decision-contract-library'
import {
  calibrateContract,
  calibrationBrier,
  calibrationFileOf,
  latestGoldenPath,
  readGolden,
  type CalibrationJev
} from './contract-calibration'

export const MISSING_KEY =
  'TYPESAFE_API_KEY is not set. Calibration needs real JEV answers, so it will not run without the key, and it never makes results up.'

export type CalibrateDeps = {
  env: NodeJS.ProcessEnv
  kitDir: string
  /** Tests inject a fake; the command asks JEV itself with the key from `env`. */
  jev?: CalibrationJev
  commit: () => Promise<string>
  now: () => Date
  log: (line: string) => void
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

function liveJev(env: NodeJS.ProcessEnv, key: string): CalibrationJev {
  const options = { environment: env, credential: async () => key }
  return {
    screen: (request) => jevScreen(request, options),
    rank: (request) => jevRank(request, options),
    decide: (request) => jevDecide(request, options)
  }
}

const percent = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`)

export function calibrationReport(file: CalibrationFile, brier: number | null): string {
  const { summary } = file
  const usd =
    summary.tokens === 'unknown'
      ? 'unknown'
      : `$${(
          (summary.tokens.input * DECISION_EXPERIMENT_TARIFF.inputUsdPerMillion +
            summary.tokens.output * DECISION_EXPERIMENT_TARIFF.outputUsdPerMillion) /
          1_000_000
        ).toFixed(6)}`
  const bands = summary.bands.map(
    (band) =>
      `| ${band.band} | ${band.n} | ${band.agree}/${band.known} | ${percent(band.disagreeRate)} | ${percent(band.upper)} |`
  )
  return [
    `# Calibration of ${file.contract}`,
    '',
    `Golden set ${file.golden.set} v${file.golden.version}, JEV ${file.jevModel}, commit ${file.commit}.`,
    '',
    '| Band | Items | Agreed | Disagreement | Wilson 95% upper |',
    '| --- | --- | --- | --- | --- |',
    ...bands,
    '',
    `- Accuracy: ${percent(summary.accuracy)}`,
    `- Confident disagreement: ${summary.confident.misses}/${summary.confident.n}, upper bound ${percent(summary.confident.upper)}`,
    `- Costly-side misses: ${summary.costly.misses}/${summary.costly.n}, upper bound ${percent(summary.costly.upper)}`,
    `- Escalation share: ${percent(summary.escalationShare)}`,
    `- Brier: ${brier === null ? 'n/a' : brier.toFixed(4)}`,
    `- Cost: ${usd} (${summary.tokens === 'unknown' ? 'tokens unknown' : `${summary.tokens.input} input tokens`})`,
    '',
    `To commit it, copy ${file.contract.replace('@', '.v')}.json to src/shared/decision-contracts/calibration/ in a PR.`,
    ''
  ].join('\n')
}

/** Runs the command; returns the folder it wrote. Refuses without a key and never overwrites. */
export async function calibrateContractCommand(
  argv: string[],
  deps: CalibrateDeps
): Promise<string> {
  const ref = flag(argv, 'contract')
  const out = flag(argv, 'out')
  if (!ref || !out) {
    throw new Error('Use --contract <id@version> --out <new folder> [--golden <golden set file>]')
  }
  const key = deps.env.TYPESAFE_API_KEY?.trim()
  if (!key) {
    throw new Error(MISSING_KEY)
  }
  if (existsSync(out)) {
    throw new Error(`${out} already exists; every calibration gets a new folder`)
  }
  const contract = contractByRef(ref)
  const goldenPath = flag(argv, 'golden') ?? latestGoldenPath(deps.kitDir, contract.id)
  if (!goldenPath) {
    throw new Error(`No golden set for ${contract.id}: add golden/${contract.id}/v1.json first`)
  }
  const golden = readGolden(goldenPath)
  const rows = await calibrateContract(
    contract,
    golden,
    deps.jev ?? liveJev(deps.env, key),
    deps.log
  )
  const answered = rows.filter((row) => row.decision !== null)
  if (!answered.length) {
    throw new Error(
      `JEV decided no item, so there is nothing to calibrate (${rows[0]?.failed ?? 'empty set'})`
    )
  }
  const file = calibrationFileOf({
    contract,
    golden,
    rows,
    commit: await deps.commit(),
    // The out folder is local to one machine, so it is not part of the recorded command.
    command: [
      'calibrate-contract.ts',
      ...argv.map((arg, index) => (argv[index - 1] === '--out' ? '<out>' : arg))
    ].join(' '),
    ranAt: deps.now().toISOString()
  })
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, `${contract.id}.v${contract.version}.json`),
    `${JSON.stringify(file, null, 2)}\n`
  )
  const report = calibrationReport(file, calibrationBrier(rows))
  writeFileSync(join(out, 'report.md'), report)
  deps.log(report)
  return out
}

async function gitHead(): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args: ['rev-parse', 'HEAD'],
    timeoutMs: 10_000
  })
  return result.code === 0 ? result.stdout.trim() : 'unknown'
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  calibrateContractCommand(process.argv.slice(2), {
    env: process.env,
    kitDir: import.meta.dirname,
    commit: gitHead,
    now: () => new Date(),
    log: (line) => process.stderr.write(`${line}\n`)
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
