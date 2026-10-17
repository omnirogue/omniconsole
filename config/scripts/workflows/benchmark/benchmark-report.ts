import { summarizeDiscoverRounds } from './benchmark-rounds'
import type { WorkflowRunResult } from '../../../../src/shared/workflow-run-result'
import type { DecideScore } from './decide-score'
import type { DiscoverScore } from './discover-score'
import type { GateReport } from './noul-gates'

export type ArmRun = {
  arm: string
  rep: number
  /** Decide: the question this attempt answered. */
  question?: string
  /** Present when the command failed before a settled run came back. */
  error?: string
  result?: WorkflowRunResult
  discover?: DiscoverScore
  decide?: DecideScore
}

export type Stat = {
  n: number
  mean: number | null
  /** Sample standard deviation and variance across repetitions; null below two values. */
  stdev: number | null
  variance: number | null
  min: number | null
  max: number | null
}

export type ArmSummary = {
  arm: string
  template: string
  runs: number
  failed: number
  recall?: Stat
  /** Seeded bugs any target matched, whatever its verdict; Quick Discover confirms nothing. */
  recallAnyVerdict?: Stat
  /** Unique seeded bugs found, of those plus every confirmed target crediting no bug. */
  precisionUnique?: Stat
  /** Confirmed targets crediting a seeded bug (duplicates count), of all confirmed targets. */
  precisionPerTarget?: Stat
  precisionAdjudicated?: Stat
  precisionAnyVerdict?: Stat
  decoysAnyVerdict?: Stat
  jevVerifyBrier?: Stat
  jevVerifyAccuracy?: Stat
  rounds?: {
    round: number
    targets: number
    confirmed: number
    knownCostUsd: number | 'unknown'
    unpricedCalls: number
  }[]
  duplicates?: Stat
  needsAdjudication?: Stat
  decoysFlagged?: Stat
  highInTopK?: Stat
  meanReciprocalRank?: Stat
  otherFindings?: Stat
  /**
   * Decide: per repetition, the mean over the matched questions of the run's JEV rubric score
   * minus the reference's; the statistics are across repetitions.
   */
  decideGap?: Stat
  /** Decide: attempts with no judge score, and why; they are left out, never counted as 0. */
  unscored?: { question: string; rep: number; reason: string }[]
  wallClockMs: Stat
  tokens: Stat & { unknownRuns: number }
  costUsd: Stat & { unknownRuns: number; partialRuns: number }
  /** Seeded bugs this arm missed, with how many runs missed each. */
  missed?: { id: string; runs: number }[]
}

export type BenchmarkReport = {
  set: string
  /** Decide: the questions every arm scored in every repetition; arms are compared only on these. */
  matchedQuestions?: string[]
  generatedAt: string
  reps: number
  arms: ArmSummary[]
  gates: GateReport[]
  runs: ArmRun[]
}

export function stat(values: readonly number[]): Stat {
  const n = values.length
  if (!n) {
    return { n, mean: null, stdev: null, variance: null, min: null, max: null }
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance =
    n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : null
  return {
    n,
    mean,
    stdev: variance === null ? null : Math.sqrt(variance),
    variance,
    min: Math.min(...values),
    max: Math.max(...values)
  }
}

const numbers = (values: readonly (number | null | undefined)[]) =>
  values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))

/** Questions with a judge score in every attempt of every arm; the only ones arms are compared on. */
export function matchedQuestions(runs: readonly ArmRun[], questions: readonly string[]): string[] {
  const attempts = new Set(runs.map((run) => `${run.arm}#${run.rep}`))
  return questions.filter((question) =>
    [...attempts].every((attempt) =>
      runs.some(
        (run) =>
          `${run.arm}#${run.rep}` === attempt &&
          run.question === question &&
          run.decide &&
          'gap' in run.decide
      )
    )
  )
}

function decideSummary(runs: readonly ArmRun[], matched: readonly string[]) {
  const reps = [...new Set(runs.map((run) => run.rep))].sort((left, right) => left - right)
  const perRep = reps.flatMap((rep) => {
    const gaps = runs.flatMap((run) =>
      run.rep === rep && matched.includes(run.question ?? '') && run.decide && 'gap' in run.decide
        ? [run.decide.gap]
        : []
    )
    return gaps.length === matched.length && gaps.length
      ? [gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length]
      : []
  })
  const unscored = runs.flatMap((run) =>
    run.decide && 'gap' in run.decide
      ? []
      : [
          {
            question: run.question ?? '?',
            rep: run.rep,
            reason:
              run.error ??
              (run.decide && 'failed' in run.decide ? run.decide.failed : 'not judged (no --judge)')
          }
        ]
  )
  return { decideGap: stat(perRep), unscored }
}

export function summarizeArm(
  arm: string,
  template: string,
  runs: readonly ArmRun[],
  matched?: readonly string[]
): ArmSummary {
  const settled = runs.filter((run) => run.result?.state === 'completed')
  const scored = runs.flatMap((run) => (run.discover ? [run.discover] : []))
  const tokens = settled.map((run) =>
    run.result!.usage.tokens === 'unknown'
      ? undefined
      : run.result!.usage.tokens.input + run.result!.usage.tokens.output
  )
  const missed = new Map<string, number>()
  for (const score of scored) {
    for (const id of score.missed) {
      missed.set(id, (missed.get(id) ?? 0) + 1)
    }
  }
  return {
    arm,
    template,
    runs: runs.length,
    failed: runs.length - settled.length,
    ...(scored.length
      ? {
          recall: stat(scored.map((score) => score.recall)),
          recallAnyVerdict: stat(scored.map((score) => score.recallAnyVerdict)),
          precisionUnique: stat(numbers(scored.map((score) => score.precisionUnique))),
          precisionPerTarget: stat(numbers(scored.map((score) => score.precisionPerTarget))),
          precisionAdjudicated: stat(numbers(scored.map((score) => score.precisionAdjudicated))),
          precisionAnyVerdict: stat(numbers(scored.map((score) => score.precisionAnyVerdict))),
          decoysAnyVerdict: stat(scored.map((score) => score.decoysAnyVerdict.length)),
          jevVerifyBrier: stat(numbers(scored.map((score) => score.jevVerify.brier))),
          jevVerifyAccuracy: stat(
            numbers(
              scored.map((score) =>
                score.jevVerify.decided ? score.jevVerify.correct / score.jevVerify.decided : null
              )
            )
          ),
          duplicates: stat(scored.map((score) => score.duplicates)),
          needsAdjudication: stat(scored.map((score) => score.needsAdjudication.length)),
          decoysFlagged: stat(scored.map((score) => score.decoysFlagged.length)),
          highInTopK: stat(scored.map((score) => score.ranking.highInTopK)),
          meanReciprocalRank: stat(scored.map((score) => score.ranking.meanReciprocalRank)),
          otherFindings: stat(scored.map((score) => score.otherFindings.length)),
          rounds: summarizeDiscoverRounds(runs),
          missed: [...missed]
            .map(([id, count]) => ({ id, runs: count }))
            .sort((left, right) => right.runs - left.runs || left.id.localeCompare(right.id))
        }
      : {}),
    ...(matched ? decideSummary(runs, matched) : {}),
    wallClockMs: stat(
      numbers(
        settled.map((run) =>
          run.result!.timing.wallClockMs === 'unknown' ? null : run.result!.timing.wallClockMs
        )
      )
    ),
    tokens: {
      ...stat(numbers(tokens)),
      unknownRuns: tokens.filter((value) => value === undefined).length
    },
    costUsd: {
      ...stat(
        numbers(
          runs.map((run) =>
            typeof run.result?.usage.costUsd === 'number' && !run.result.usage.costPartial
              ? run.result.usage.costUsd
              : undefined
          )
        )
      ),
      unknownRuns: runs.filter((run) => typeof run.result?.usage.costUsd !== 'number').length,
      partialRuns: runs.filter((run) => run.result?.usage.costPartial).length
    }
  }
}

const fixed = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? '–' : value.toFixed(digits)

const spread = (value: Stat | undefined, digits = 2) =>
  !value || value.mean === null
    ? '–'
    : `${fixed(value.mean, digits)}${value.stdev === null ? '' : ` ± ${fixed(value.stdev, digits)}`}`

export function reportMarkdown(report: BenchmarkReport): string {
  const discover = report.arms.some((arm) => arm.recall)
  const lines = [
    `# Workflow benchmark: ${report.set}`,
    '',
    `Generated ${report.generatedAt}; ${report.reps} repetition(s) per arm. Values are mean ± sample standard deviation across repetitions. Cost includes recorded terminal-attempt bills; unknown and partial totals are excluded from the mean.`
  ]
  if (report.arms.length) {
    lines.push(
      '',
      discover
        ? '| Arm | Template | Runs (failed) | Recall | Recall (any verdict) | Precision (unique defects) | Precision (per target) | Duplicates | Decoys flagged | Needs adjudication | High in top K | MRR | Other findings | Wall clock (s) | Tokens | Cost USD (unknown / partial runs) |'
        : `| Arm | Template | Attempts (failed) | Rubric gap vs reference, over ${report.matchedQuestions?.length ?? 0} matched questions | Unscored attempts | Wall clock (s) | Tokens | Cost USD (unknown / partial runs) |`,
      discover
        ? '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
        : '|---|---|---|---|---|---|---|---|'
    )
  }
  for (const arm of report.arms) {
    const common = `| ${arm.arm} | ${arm.template} | ${arm.runs} (${arm.failed}) |`
    const tail = `${spread({ ...arm.wallClockMs, mean: arm.wallClockMs.mean === null ? null : arm.wallClockMs.mean / 1000, stdev: arm.wallClockMs.stdev === null ? null : arm.wallClockMs.stdev / 1000 }, 0)} | ${arm.tokens.unknownRuns ? `unknown for ${arm.tokens.unknownRuns}` : spread(arm.tokens, 0)} | ${spread(arm.costUsd, 4)} (${arm.costUsd.unknownRuns} / ${arm.costUsd.partialRuns}) |`
    lines.push(
      discover
        ? `${common} ${spread(arm.recall)} | ${spread(arm.recallAnyVerdict)} | ${spread(arm.precisionUnique)} | ${spread(arm.precisionPerTarget)} | ${spread(arm.duplicates, 1)} | ${spread(arm.decoysFlagged, 1)} | ${spread(arm.needsAdjudication, 1)} | ${spread(arm.highInTopK, 1)} | ${spread(arm.meanReciprocalRank)} | ${spread(arm.otherFindings, 1)} | ${tail}`
        : `${common} ${spread(arm.decideGap)} | ${arm.unscored?.length ?? 0} | ${tail}`
    )
  }
  if (discover) {
    for (const arm of report.arms) {
      lines.push(
        '',
        `${arm.arm}: strict precision ${spread(arm.precisionPerTarget)}; adjudicated/keyed precision ${spread(arm.precisionAdjudicated)}; any-verdict precision ${spread(arm.precisionAnyVerdict)}; any-verdict decoys ${spread(arm.decoysAnyVerdict, 1)}; JEV verify Brier ${spread(arm.jevVerifyBrier)}; JEV verify decision accuracy ${spread(arm.jevVerifyAccuracy)}.`
      )
    }
    lines.push(
      '',
      'Strict precision and "Missed by" count confirmed targets only. Ranking scores the actionable order the page shows. Recall (any verdict) also counts refuted and unverified ones; it is the only recall for a single-pass arm such as Quick Discover, whose targets are all unverified.'
    )
  }
  for (const arm of report.arms) {
    for (const round of arm.rounds ?? []) {
      lines.push(
        '',
        `${arm.arm} round ${round.round}: ${round.targets} targets, ${round.confirmed} confirmed; known cost $${round.knownCostUsd === 'unknown' ? 'unknown' : round.knownCostUsd.toFixed(4)}, ${round.unpricedCalls} unpriced/partial calls (other steps are in the run total).`
      )
    }
  }
  for (const arm of report.arms.filter((entry) => entry.missed?.length)) {
    lines.push(
      '',
      `Missed by ${arm.arm}: ${arm.missed!.map((row) => `${row.id} (${row.runs}/${arm.runs})`).join(', ')}`
    )
  }
  for (const arm of report.arms.filter((entry) => entry.unscored?.length)) {
    lines.push(
      '',
      `Unscored for ${arm.arm}: ${arm.unscored!.map((row) => `${row.question} #${row.rep} (${row.reason})`).join('; ')}`
    )
  }
  if (report.gates.length) {
    lines.push(
      '',
      "## Yes/no gates: JEV NOUL against today's rule",
      '',
      "| Gate | n | NOUL Brier | NOUL accuracy at 0.3 / 0.4 / 0.5 / 0.6 / 0.7 | NOUL unsure (0.35–0.65) | NOUL $/decision | Today's rule | Rule accuracy | Rule Brier | Rule unsure |",
      '|---|---|---|---|---|---|---|---|---|---|---|'
    )
    for (const gate of report.gates) {
      const cost = gate.noul.costUsdPerDecision
      lines.push(
        `| ${gate.gate} | ${gate.n} (${gate.noul.failed} NOUL failed) | ${fixed(gate.noul.brier, 3)} | ${gate.noul.byThreshold.map((row) => fixed(row.accuracy)).join(' / ')} | ${fixed(gate.noul.unsureRate)} | ${cost === 'unknown' ? 'unknown' : cost.toFixed(6)} | ${gate.rule} | ${fixed(gate.current.accuracy)} | ${fixed(gate.current.brier, 3)} | ${fixed(gate.current.unsureRate)} |`
      )
    }
  }
  return `${lines.join('\n')}\n`
}
