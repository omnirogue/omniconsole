/**
 * Runs a workflow benchmark set against the running OmniConsole app and writes a report.
 *
 *   npx --yes tsx config/scripts/workflows/benchmark/run-workflow-benchmark.ts \
 *     --set discover-seeded --arms arms.json --reps 3 --worktree path:/abs/fixture --out /tmp/bench-1
 *
 * See README.md in this folder for the sets, arms, flags and what a run costs.
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { jevRank } from '../../../../src/main/structured-decisions/jev-rank'
import { runProcess } from '../../../../src/shared/child-process/run-process'
import { reportMarkdown } from './benchmark-report'
import { readArms, runBenchmark, type Arm, type BenchmarkSet } from './benchmark-run'

const KIT_DIR = import.meta.dirname
/** A Discover run can take most of an hour on a busy machine. */
const RUN_TIMEOUT_MS = 90 * 60_000

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

async function main(argv: string[]): Promise<void> {
  const materialize = flag(argv, 'materialize')
  if (materialize) {
    const target = resolve(materialize)
    if (existsSync(target)) {
      throw new Error(`${target} already exists; give a new folder`)
    }
    cpSync(join(KIT_DIR, 'discover-seeded', 'fixture'), target, { recursive: true })
    process.stdout.write(
      `Copied the seeded fixture to ${target}. Add it in OmniConsole as a folder workspace, then pass --worktree path:${target}.\n`
    )
    return
  }
  const set = flag(argv, 'set') as BenchmarkSet | undefined
  const out = flag(argv, 'out')
  if ((set !== 'discover-seeded' && set !== 'decide') || !out) {
    throw new Error(
      'Use --set discover-seeded|decide --out <new folder> [--arms <file>] [--reps <n>] [--worktree <selector>] [--omni <path>] [--noul] [--judge] [--attempts-dir <dir>] [--gates-only], or --materialize <folder>'
    )
  }
  if (existsSync(out)) {
    throw new Error(`${out} already exists; every report gets a new folder`)
  }
  const armsFile = flag(argv, 'arms')
  const arms: Arm[] = armsFile
    ? readArms(armsFile)
    : [{ name: 'default', template: set === 'decide' ? 'council' : 'discover' }]
  const reps = Number(flag(argv, 'reps') ?? '1')
  if (!Number.isInteger(reps) || reps < 1 || reps > 20) {
    throw new Error('--reps takes a whole number from 1 to 20')
  }
  const omni = flag(argv, 'omni') ?? 'omni'
  const worktree = flag(argv, 'worktree')
  const attemptsDir = flag(argv, 'attempts-dir')
  const report = await runBenchmark({
    set,
    arms,
    reps,
    kitDir: KIT_DIR,
    exec: async (args) =>
      runProcess({
        program: omni,
        args,
        timeoutMs: RUN_TIMEOUT_MS,
        maxOutputBytes: 32 * 1024 * 1024
      }),
    ...(worktree ? { worktree } : {}),
    ...(argv.includes('--noul') ? { noul: {} } : {}),
    ...(argv.includes('--judge') ? { judge: jevRank } : {}),
    ...(attemptsDir ? { attemptsDir } : {}),
    gatesOnly: argv.includes('--gates-only'),
    log: (line) => process.stderr.write(`${line}\n`)
  })
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(out, 'report.md'), reportMarkdown(report))
  process.stdout.write(reportMarkdown(report))
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
