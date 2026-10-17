import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { jevRank } from '../../../../src/main/structured-decisions/jev-rank'
import type { WorkflowRunResult } from '../../../../src/shared/workflow-run-result'
import { WORKFLOW_SCREEN_SET_ASIDE } from '../../../../src/shared/workflow-graph'
import {
  matchedQuestions,
  summarizeArm,
  type ArmRun,
  type BenchmarkReport
} from './benchmark-report'
import { scoreDecideAnswer, type DecideSet } from './decide-score'
import { scoreDiscoverRun, type AnswerKey } from './discover-score'
import {
  gateReport,
  probeFinalCheck,
  probeOneAnswer,
  probeSetAside,
  type GateReport,
  type GateSample,
  type NoulAsk,
  type PairRank
} from './noul-gates'

/**
 * An arm is a template plus an optional spec override (a JSON file `--spec-file` reads) and the
 * `omni workflow run` flags it pins; an unset field adds no flag.
 */
export type Arm = {
  name: string
  template: string
  specFile?: string
  routes?: string[]
  /** `--models`, e.g. `*=cheap;verify=frontier;report=frontier`. */
  models?: string
  /** Resolved provider:model ids expected in each executed step; mismatches invalidate the arm. */
  expectedModels?: Record<string, string[]>
  runsOn?: 'fleet' | 'local'
  /** An agent starts discover only with the person who asked and their words. */
  requestedBy?: string
  request?: string
}

export type BenchmarkSet = 'discover-seeded' | 'decide'

/** Runs `omni` with these arguments; the benchmark only ever calls `omni workflow run … --json`. */
export type Exec = (
  args: string[]
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export type BenchmarkOptions = {
  set: BenchmarkSet
  arms: Arm[]
  reps: number
  /** The kit's own folder: answer key, prompt and decision set are read from here. */
  kitDir: string
  exec: Exec
  worktree?: string
  /** Ask JEV the NOUL gate questions (a few cents); off by default. */
  noul?: { ask?: NoulAsk; rank?: PairRank }
  /** Score Decide answers with JEV against the references; off by default. */
  judge?: typeof jevRank
  /** The app's `local-workflow-attempts` folder, to read the screen certainty runs kept. */
  attemptsDir?: string
  /** Decide only: measure the gates without running any workflow. */
  adjudications?: Record<string, Record<string, 'real' | 'false'>>
  gatesOnly?: boolean
  log?: (line: string) => void
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** An arms file (a JSON list of arms), each `specFile` resolved against the file's folder. */
export function readArms(file: string): Arm[] {
  return readJson<Arm[]>(file).map((arm) => ({
    ...arm,
    ...(arm.specFile ? { specFile: resolve(dirname(file), arm.specFile) } : {})
  }))
}

async function runOnce(
  options: BenchmarkOptions,
  arm: Arm,
  prompt: { file: string } | { text: string }
): Promise<{ result?: WorkflowRunResult; error?: string }> {
  const args = [
    'workflow',
    'run',
    '--template',
    arm.template,
    '--origin',
    'benchmark',
    '--operation-id',
    randomUUID(),
    ...('file' in prompt ? ['--prompt-file', prompt.file] : ['--prompt', prompt.text]),
    ...(options.worktree ? ['--worktree', options.worktree] : []),
    ...(arm.routes?.length ? ['--routes', arm.routes.join(',')] : []),
    ...(arm.specFile ? ['--spec-file', arm.specFile] : []),
    ...(arm.models ? ['--models', arm.models] : []),
    ...(arm.runsOn ? ['--runs-on', arm.runsOn] : []),
    ...(arm.requestedBy ? ['--requested-by', arm.requestedBy] : []),
    ...(arm.request ? ['--request', arm.request] : []),
    '--json'
  ]
  const outcome = await options.exec(args)
  try {
    const result = JSON.parse(outcome.stdout) as WorkflowRunResult
    for (const [step, expected] of Object.entries(arm.expectedModels ?? {})) {
      const actual = result.calls
        .filter((call) => call.stage === step)
        .map((call) => `${call.route}:${call.model}`)
      if (actual.some((model) => !expected.includes(model)) || !actual.length) {
        return {
          result,
          error: `${arm.name}: ${step} resolved to ${actual.join(', ') || 'no calls'}; expected ${expected.join(', ')}`
        }
      }
    }
    return result.state === 'completed'
      ? { result }
      : { result, error: result.error ?? `the run ended ${result.state}` }
  } catch {
    const reason = outcome.stderr.trim().split('\n').at(-1) || `exit ${outcome.code}`
    return { error: `omni ${args.slice(0, 4).join(' ')} gave no result: ${reason}` }
  }
}

/** P(the screen's score reaches the set-aside line) from the level probabilities a run kept (#633). */
export function screenKeepProbabilities(
  attemptsDir: string,
  executionId: string
): Map<string, number> {
  const keep = new Map<string, number>()
  let records: Record<
    string,
    { outcome?: { value?: { certainty?: Record<string, { levels?: number[] }> } } }
  >
  try {
    records = readJson(join(attemptsDir, executionId, 'jev-ballots.json'))
  } catch {
    return keep
  }
  for (const record of Object.values(records)) {
    for (const [key, certainty] of Object.entries(record.outcome?.value?.certainty ?? {})) {
      if (Array.isArray(certainty.levels)) {
        keep.set(
          key,
          certainty.levels.slice(WORKFLOW_SCREEN_SET_ASIDE).reduce((sum, p) => sum + p, 0)
        )
      }
    }
  }
  return keep
}

async function discoverGates(
  options: BenchmarkOptions,
  runs: ArmRun[],
  goal: string
): Promise<GateReport[]> {
  const findings = runs.flatMap((run) => {
    const keep =
      options.attemptsDir && run.result
        ? screenKeepProbabilities(options.attemptsDir, run.result.executionId)
        : new Map<string, number>()
    return (run.discover?.matches ?? []).map((match) => {
      const target = run.result!.results.targets.findLast((entry) => entry.key === match.key)!
      return {
        id: `${run.arm}#${run.rep}:${match.key}`,
        truth: match.match?.kind === 'bug',
        keyed: !!match.match,
        text: `${target.title}\n${target.location}\n${target.detail}`,
        ...(target.jevScore !== undefined ? { jevScore: target.jevScore } : {}),
        repeats: target.repeats,
        ...(keep.has(match.key) ? { keepProbability: keep.get(match.key)! } : {})
      }
    })
  })
  const samples = await probeSetAside(goal, findings, options.noul?.ask)
  const keyed = new Set(findings.filter((finding) => finding.keyed).map((finding) => finding.id))
  const rule = `JEV screen score ≥ ${WORKFLOW_SCREEN_SET_ASIDE} or reported more than once`
  return [
    gateReport(
      'set-aside: findings in the answer key',
      rule,
      samples.filter((sample) => keyed.has(sample.id))
    ),
    gateReport('set-aside: every finding (unkeyed count as non-findings)', rule, samples)
  ]
}

async function decideGates(options: BenchmarkOptions, set: DecideSet): Promise<GateReport[]> {
  const ask = options.noul?.ask
  const oneAnswer: GateSample[] = await probeOneAnswer(set.questions, ask)
  const finalCheck = await probeFinalCheck(
    set.questions.map((entry) => ({ id: entry.id, task: entry.question, ...entry.pair })),
    ask,
    options.noul?.rank
  )
  return [
    gateReport('one-answer routing', 'none: every question is handled as judgment', oneAnswer),
    gateReport(
      'final check: is B better than A',
      'jevRank pairwise, both orders (unsure: 0.2–0.8 band or the orders disagree)',
      finalCheck
    )
  ]
}

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const log = options.log ?? (() => {})
  const runs: ArmRun[] = []
  const setDir = join(options.kitDir, options.set)
  const key =
    options.set === 'discover-seeded'
      ? readJson<AnswerKey>(join(setDir, 'answer-key.json'))
      : undefined
  const decide =
    options.set === 'decide' ? readJson<DecideSet>(join(setDir, 'questions.json')) : undefined
  for (const arm of options.gatesOnly ? [] : options.arms) {
    for (let rep = 1; rep <= options.reps; rep++) {
      if (key) {
        log(`${arm.name} #${rep}: Discover on the seeded fixture`)
        const outcome = await runOnce(options, arm, { file: join(setDir, 'prompt.md') })
        runs.push({
          arm: arm.name,
          rep,
          ...outcome,
          ...(outcome.result && !outcome.error
            ? { discover: scoreDiscoverRun(outcome.result, key, options.adjudications?.[outcome.result.executionId]) }
            : {})
        })
        continue
      }
      for (const question of decide!.questions) {
        log(`${arm.name} #${rep}: ${question.id}`)
        const outcome = await runOnce(options, arm, { text: question.question })
        const answer = outcome.error ? undefined : outcome.result?.markdown
        runs.push({
          arm: arm.name,
          rep,
          question: question.id,
          ...outcome,
          ...(answer && options.judge
            ? { decide: await scoreDecideAnswer(decide!, question, answer, options.judge) }
            : {})
        })
      }
    }
  }
  const gates = !options.noul
    ? []
    : key
      ? await discoverGates(options, runs, readFileSync(join(setDir, 'prompt.md'), 'utf8'))
      : await decideGates(options, decide!)
  const matched = decide
    ? matchedQuestions(
        runs,
        decide.questions.map((question) => question.id)
      )
    : undefined
  return {
    set: options.set,
    ...(matched ? { matchedQuestions: matched } : {}),
    generatedAt: new Date().toISOString(),
    reps: options.reps,
    arms: (options.gatesOnly ? [] : options.arms).map((arm) =>
      summarizeArm(
        arm.name,
        arm.template,
        runs.filter((run) => run.arm === arm.name),
        matched
      )
    ),
    gates,
    runs
  }
}
