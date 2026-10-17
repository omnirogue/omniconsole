/**
 * Direct agent versus coordinated workflow on the frozen implement-bounded set.
 *
 *   npx --yes tsx config/scripts/workflows/benchmark/run-direct-vs-coordinated.ts \
 *     --workspace /abs/registered-folder --run <run_id> --out /abs/new-report-folder
 *
 * Run it from the coordinator terminal the Run is bound to. See README.md ("Direct agent versus
 * coordinated workflow") for what it measures, what it costs and what it cannot say.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '../../../../src/shared/child-process/run-process'
import { transcriptUsage } from './agent-transcript-usage'
import {
  pairTasks,
  reportMarkdown,
  summarizeArm,
  type ArmRun,
  type BenchArm,
  type BenchReport
} from './direct-vs-coordinated-report'
import { runArm } from './direct-vs-coordinated-run'
import type { BenchDeps, BenchOptions, BenchTask, Seat } from './direct-vs-coordinated-stage'
import {
  IMPLEMENT_BOUNDED_KIT_DIR,
  materializeFixture,
  verifyAcceptance
} from './implement-bounded-verify'

const STAGE_TIMEOUT_MS = 15 * 60_000

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}

function seat(value: string | undefined, fallback: Seat): Seat {
  if (!value) {
    return fallback
  }
  const [agent, model, effort] = value.split(':')
  return { agent: agent!, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

function readText(path: string | null): string | null {
  try {
    return path ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

async function main(argv: string[]): Promise<void> {
  const workspace = flag(argv, 'workspace')
  const out = flag(argv, 'out')
  const runId = flag(argv, 'run')
  if (!workspace || !out || !runId) {
    throw new Error(
      'Use --workspace <registered folder workspace> --run <run_id> --out <new folder> [--reps <n>] [--tasks <id,id>] [--arms direct,coordinated] [--implementer agent[:model[:effort]]] [--reviewer agent[:model[:effort]]] [--omni <path>] [--host <name>] [--owner <text>]'
    )
  }
  if (existsSync(out)) {
    throw new Error(`${out} already exists; every report gets a new folder`)
  }
  const set = JSON.parse(readFileSync(join(IMPLEMENT_BOUNDED_KIT_DIR, 'tasks.json'), 'utf8')) as {
    version: number
    tasks: BenchTask[]
  }
  const wanted = flag(argv, 'tasks')?.split(',')
  const tasks = set.tasks.filter((task) => !wanted || wanted.includes(task.id))
  const arms = (flag(argv, 'arms')?.split(',') ?? ['direct', 'coordinated']) as BenchArm[]
  const reps = Number(flag(argv, 'reps') ?? '1')
  if (!Number.isInteger(reps) || reps < 1 || reps > 5 || tasks.length === 0) {
    throw new Error('--reps takes 1 to 5, and --tasks must name tasks of the set')
  }
  const omni = flag(argv, 'omni') ?? 'omni'
  const startedAt = new Date()
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  const options: BenchOptions = {
    runId,
    workspace: `path:${resolve(workspace)}`,
    host: flag(argv, 'host') ?? hostname(),
    owner: flag(argv, 'owner') ?? 'Benchmark harness, for the person who started it',
    implementer: seat(flag(argv, 'implementer'), { agent: 'claude' }),
    reviewer: seat(flag(argv, 'reviewer'), { agent: 'codex' }),
    stageTimeoutMs: STAGE_TIMEOUT_MS
  }
  const deps: BenchDeps = {
    omni: (args) =>
      runProcess({
        program: omni,
        args,
        timeoutMs: STAGE_TIMEOUT_MS + 60_000,
        maxOutputBytes: 32 * 1024 * 1024
      }),
    materialize: (label) => {
      const dir = join(resolve(workspace), stamp, label)
      materializeFixture(dir)
      return dir
    },
    verify: verifyAcceptance,
    readUsage: (path, agent) => transcriptUsage(agent, readText(path)),
    readText,
    now: () => Date.now(),
    log: (line) => process.stderr.write(`${line}\n`)
  }
  mkdirSync(out, { recursive: true })
  const runs: ArmRun[] = []
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const [index, task] of tasks.entries()) {
      // Why: alternating which arm goes first keeps a warm cache from always favouring one arm.
      const order = (index + rep) % 2 === 0 ? arms : arms.toReversed()
      for (const arm of order) {
        deps.log(`${task.id} · ${arm} · rep ${rep}`)
        runs.push(await runArm(deps, options, arm, task, rep))
        // Why: written after every run so an interrupted benchmark keeps what it measured.
        writeFileSync(join(out, 'runs.partial.json'), `${JSON.stringify(runs, null, 2)}\n`)
      }
    }
  }
  const report: BenchReport = {
    set: 'implement-bounded',
    setVersion: set.version,
    startedAt: startedAt.toISOString(),
    host: options.host,
    runs,
    arms: arms.map((arm) => summarizeArm(arm, runs)),
    pairs: pairTasks(runs),
    notes: [
      `Implementer ${JSON.stringify(options.implementer)}; reviewer ${JSON.stringify(options.reviewer)}. The model each stage really ran is observedModel in report.json.`,
      'A direct run that fails hidden acceptance gets the same repair brief as the coordinated arm; carrying the failure back is counted as one human intervention with zero thinking time, so direct wall clock is a lower bound.',
      'The coordinator here is this script. A coordinating agent would add its own time and tokens, which this run does not measure (unknown, not zero).',
      'Tokens come from each agent transcript; a stage whose transcript could not be read makes the arm total unknown. Cost is never computed.'
    ]
  }
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(out, 'report.md'), reportMarkdown(report))
  process.stdout.write(reportMarkdown(report))
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
