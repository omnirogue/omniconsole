/**
 * The report of the direct-agent versus coordinated-workflow benchmark: same bounded task, same
 * brief, one agent on its own against implement → review (when justified) → deterministic QA.
 * Pure, so the arithmetic is tested without launching an agent. Unknown is never 0.
 */

export type BenchArm = 'direct' | 'coordinated'

export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type StageRecord = {
  stage: 'implement' | 'review' | 'repair'
  dispatchId: string | null
  agent: string
  /** The model the provider transcript showed; null when it could not be read. */
  observedModel: string | null
  startedAtMs: number
  /** When worker-start returned ready: the task input was accepted. Null if it never was. */
  launchedAtMs: number | null
  /** When the coordinator received the worker's report. Null if none arrived. */
  reportedAtMs: number | null
  endedAtMs: number
  outcome: 'succeeded' | 'failed' | 'timeout' | 'refused'
  /** Dispatch creation to accepted task input, from the worker outcome receipt. */
  startupMs: number | null
  tokens: TokenUsage | 'unknown'
  detail?: string
}

export type QaRecord = { startedAtMs: number; endedAtMs: number; pass: number; fail: number }

export type ArmRun = {
  arm: BenchArm
  taskId: string
  rep: number
  startedAtMs: number
  endedAtMs: number
  stages: StageRecord[]
  qa: QaRecord[]
  /** The hidden acceptance tests passed at the end. */
  verified: boolean
  /** They passed on the first QA run, with no repair. */
  firstPassVerified: boolean
  retries: number
  /** Times a person had to step in: a relayed failure, or a prompt only a person may answer. */
  humanInterventions: number
  coordinatorQuestions: number
  review: 'pass' | 'block' | 'unknown' | 'not-justified'
  error?: string
}

export type ArmSummary = {
  arm: BenchArm
  runs: number
  verified: number
  firstPassVerified: number
  errors: number
  meanWallClockMs: number | null
  /** Accepted input to received report, summed over a run's stages. Null when a stage lacks either time. */
  meanAgentMs: number | null
  meanQaMs: number | null
  /** Wall clock minus agent and QA time: task creation, launch, observation, release. */
  meanCoordinationMs: number | null
  agentDispatches: number
  retries: number
  humanInterventions: number
  /** The sum when every stage of every run reported tokens, else unknown. */
  tokens: TokenUsage | 'unknown'
  partialTokens: TokenUsage & { reportedStages: number; stages: number }
  /** No price is recorded for an agent seat, so cost is never computed here. */
  costUsd: 'unknown'
}

export type PairedTask = {
  taskId: string
  rep: number
  directWallClockMs: number | null
  coordinatedWallClockMs: number | null
  /** Coordinated wall clock over direct; null when either run is missing or errored. */
  wallClockRatio: number | null
  directVerified: boolean | null
  coordinatedVerified: boolean | null
}

export type BenchReport = {
  set: string
  setVersion: number
  startedAt: string
  host: string
  runs: ArmRun[]
  arms: ArmSummary[]
  pairs: PairedTask[]
  notes: string[]
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

function addTokens(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite
  }
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Time the agents themselves worked; null when any stage has no launch or report time. */
export function runAgentMs(run: ArmRun): number | null {
  let total = 0
  for (const stage of run.stages) {
    // Why typeof: reports written before these fields existed have neither, and that is unknown too.
    if (typeof stage.launchedAtMs !== 'number' || typeof stage.reportedAtMs !== 'number') {
      return null
    }
    total += stage.reportedAtMs - stage.launchedAtMs
  }
  return total
}

function known(values: (number | null)[]): number[] | null {
  return values.every((value): value is number => value !== null) ? values : null
}

export function runQaMs(run: ArmRun): number {
  return run.qa.reduce((sum, qa) => sum + (qa.endedAtMs - qa.startedAtMs), 0)
}

export function summarizeArm(arm: BenchArm, runs: ArmRun[]): ArmSummary {
  const own = runs.filter((run) => run.arm === arm)
  // Why: a run that errored has no honest duration; it counts as a run and an error, never a time.
  const timed = own.filter((run) => !run.error)
  const stages = own.flatMap((run) => run.stages)
  const reported = stages.filter(
    (stage): stage is StageRecord & { tokens: TokenUsage } => stage.tokens !== 'unknown'
  )
  const partial = reported.reduce((sum, stage) => addTokens(sum, stage.tokens), ZERO)
  const agentMs = known(timed.map(runAgentMs))
  return {
    arm,
    runs: own.length,
    verified: own.filter((run) => run.verified).length,
    firstPassVerified: own.filter((run) => run.firstPassVerified).length,
    errors: own.length - timed.length,
    meanWallClockMs: mean(timed.map((run) => run.endedAtMs - run.startedAtMs)),
    meanAgentMs: agentMs ? mean(agentMs) : null,
    meanQaMs: mean(timed.map(runQaMs)),
    meanCoordinationMs: agentMs
      ? mean(
          timed.map(
            (run, index) => run.endedAtMs - run.startedAtMs - agentMs[index]! - runQaMs(run)
          )
        )
      : null,
    agentDispatches: stages.length,
    retries: own.reduce((sum, run) => sum + run.retries, 0),
    humanInterventions: own.reduce((sum, run) => sum + run.humanInterventions, 0),
    tokens: stages.length > 0 && reported.length === stages.length ? partial : 'unknown',
    partialTokens: { ...partial, reportedStages: reported.length, stages: stages.length },
    costUsd: 'unknown'
  }
}

export function pairTasks(runs: ArmRun[]): PairedTask[] {
  const keys = [...new Set(runs.map((run) => `${run.taskId}\u0000${run.rep}`))]
  return keys.map((key) => {
    const [taskId, rep] = key.split('\u0000') as [string, string]
    const find = (arm: BenchArm): ArmRun | undefined =>
      runs.find((run) => run.arm === arm && run.taskId === taskId && run.rep === Number(rep))
    const wall = (run: ArmRun | undefined): number | null =>
      run && !run.error ? run.endedAtMs - run.startedAtMs : null
    const direct = find('direct')
    const coordinated = find('coordinated')
    const directMs = wall(direct)
    const coordinatedMs = wall(coordinated)
    return {
      taskId,
      rep: Number(rep),
      directWallClockMs: directMs,
      coordinatedWallClockMs: coordinatedMs,
      wallClockRatio:
        directMs !== null && coordinatedMs !== null && directMs > 0
          ? coordinatedMs / directMs
          : null,
      directVerified: direct ? direct.verified : null,
      coordinatedVerified: coordinated ? coordinated.verified : null
    }
  })
}

function seconds(ms: number | null): string {
  return ms === null ? 'unknown' : `${(ms / 1000).toFixed(1)} s`
}

function tokenText(summary: ArmSummary): string {
  const { tokens, partialTokens: partial } = summary
  if (tokens !== 'unknown') {
    return `${tokens.input + tokens.cacheRead + tokens.cacheWrite} in (${tokens.cacheRead} cached), ${tokens.output} out`
  }
  return `unknown (${partial.reportedStages} of ${partial.stages} agent stages reported: ${partial.input + partial.cacheRead + partial.cacheWrite} in, ${partial.output} out)`
}

export function reportMarkdown(report: BenchReport): string {
  const armRows = report.arms.map(
    (arm) =>
      `| ${arm.arm} | ${arm.runs} | ${arm.verified} | ${arm.firstPassVerified} | ${seconds(arm.meanWallClockMs)} | ${seconds(arm.meanAgentMs)} | ${seconds(arm.meanCoordinationMs)} | ${seconds(arm.meanQaMs)} | ${arm.agentDispatches} | ${arm.retries} | ${arm.humanInterventions} | ${arm.errors} |`
  )
  const pairRows = report.pairs.map(
    (pair) =>
      `| ${pair.taskId} | ${pair.rep} | ${seconds(pair.directWallClockMs)} | ${seconds(pair.coordinatedWallClockMs)} | ${pair.wallClockRatio === null ? 'unknown' : `${pair.wallClockRatio.toFixed(2)}×`} | ${pair.directVerified ?? 'not run'} | ${pair.coordinatedVerified ?? 'not run'} |`
  )
  return [
    `# Direct agent versus coordinated workflow: ${report.set} v${report.setVersion}`,
    `Started ${report.startedAt} on ${report.host}. ${report.runs.length} runs.`,
    '## By arm',
    '| arm | runs | verified | verified first pass | mean wall clock | mean agent time | mean coordination | mean QA | agent dispatches | retries | human interventions | errors |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...armRows,
    '',
    ...report.arms.map(
      (arm) => `- ${arm.arm} tokens: ${tokenText(arm)}. Cost: unknown (no seat price is recorded).`
    ),
    '## Same task, both arms',
    '| task | rep | direct | coordinated | coordinated ÷ direct | direct verified | coordinated verified |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...pairRows,
    '## Notes',
    ...report.notes.map((note) => `- ${note}`),
    ''
  ].join('\n')
}
