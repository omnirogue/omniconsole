import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProcessResult } from '../../../../shared/child-process/process-spec'
import { WORKFLOW_CHECK_VERSION_BUDGET_SECONDS } from '../../../../shared/workflow-graph'
import type { GraphCheckRequest, GraphCheckResult } from './graph-plan-types'

export const GRAPH_CHECK_DETAIL_CHARS = 2_000
const CASE_LABEL_CHARS = 60
const OUT_OF_TIME = "Not run: this version's time for its practice cases ran out."
const CUT_SHORT = "Stopped: this version's time for its practice cases ran out."

/** One run of the command: what it printed, or why it could not start. */
export type GraphCheckRun = ProcessResult | { error: string }

/** Runs the command once, with `values` replacing their placeholders and `env` added. */
export type GraphCheckLaunch = (input: {
  values: Record<string, string>
  env: Record<string, string>
  timeoutMs: number
}) => Promise<GraphCheckRun>

const SCORE_LINE = /^\s*SCORE:\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*$/i

/**
 * The score a check printed: the last `SCORE: <number>` line anywhere, or under Improve rules 2
 * only when it is the last non-empty line, so a score echoed mid-output never counts.
 */
export function graphCheckScore(output: string, lastLineOnly = false): number | undefined {
  const last = lastLineOnly
    ? SCORE_LINE.exec(output.split(/\r?\n/).findLast((line) => line.trim()) ?? '')
    : [...output.matchAll(new RegExp(SCORE_LINE.source, 'gim'))].at(-1)
  const value = last ? Number(last[1]) : Number.NaN
  return Number.isFinite(value) ? value : undefined
}

/** One run's result: exit 0 passes, a time limit fails, a command that cannot start is unknown. */
export function graphCheckVerdict(
  run: GraphCheckRun,
  timeoutMs: number,
  scoreLastLine: boolean
): GraphCheckResult {
  if ('error' in run) {
    return { passed: false, unavailable: true, detail: `The check could not start: ${run.error}` }
  }
  const output = [run.stdout, run.stderr]
    .filter((part) => part.trim())
    .join('\n')
    .trim()
  const score = graphCheckScore(run.stdout, scoreLastLine)
  const tail = output.slice(-GRAPH_CHECK_DETAIL_CHARS)
  if (run.timedOut) {
    return { passed: false, detail: `Timed out after ${timeoutMs / 1000}s.\n${tail}`.trim() }
  }
  return {
    passed: run.code === 0,
    ...(score !== undefined ? { score } : {}),
    detail: tail || `Exited with code ${run.code ?? 'none'}.`
  }
}

const caseLabel = (text: string) =>
  text.length > CASE_LABEL_CHARS ? `${text.slice(0, CASE_LABEL_CHARS - 1)}…` : text

type CaseResult = GraphCheckResult & { timedOut?: number }

function caseLine(index: number, text: string, result: CaseResult): string {
  const verdict = result.unavailable
    ? 'could not run'
    : result.passed
      ? 'passed'
      : result.timedOut
        ? `timed out after ${result.timedOut / 1000}s`
        : 'failed'
  const score = result.score !== undefined ? ` · SCORE ${result.score}` : ''
  return `Case ${index + 1} (${caseLabel(text)}): ${verdict}${score}`
}

/**
 * Runs the check once per practice case, one after another: `{case}` becomes the case and
 * $OMNI_CASE_FILE a private file holding it. Each case has its own time limit and all of a
 * version's cases share one budget; a case the budget leaves no time for is not run and counts
 * as unavailable, never as passed. The version passes only when every case passes.
 */
export async function runGraphCheckCases(
  request: GraphCheckRequest & { cases: string[] },
  options: {
    dir: string
    launch: GraphCheckLaunch
    timeoutMs: number
    signal?: AbortSignal
    now?: () => number
  }
): Promise<GraphCheckResult> {
  const now = options.now ?? Date.now
  const budgetMs = WORKFLOW_CHECK_VERSION_BUDGET_SECONDS * 1000
  const started = now()
  const results: CaseResult[] = []
  for (const [index, text] of request.cases.entries()) {
    const left = budgetMs - (now() - started)
    if (left <= 0 || options.signal?.aborted) {
      results.push({ passed: false, unavailable: true, detail: OUT_OF_TIME })
      continue
    }
    const file = join(options.dir, `case-${index + 1}.txt`)
    await writeFile(file, text, { mode: 0o600 })
    const limit = Math.min(options.timeoutMs, left)
    const run = await options.launch({
      values: { '{case}': text },
      env: { OMNI_CASE_FILE: file },
      timeoutMs: limit
    })
    const result = graphCheckVerdict(run, limit, request.scoreLastLine === true)
    // Cut short by the shared budget rather than its own limit: its result is unknown.
    const timedOut = 'timedOut' in run && run.timedOut
    results.push(
      limit < options.timeoutMs && timedOut
        ? { passed: false, unavailable: true, detail: CUT_SHORT }
        : { ...result, ...(timedOut ? { timedOut: limit } : {}) }
    )
  }
  return graphCheckCaseSummary(request.cases, results, request.sealed ? 'kept-back' : 'practice')
}

function graphCheckCaseSummary(
  cases: string[],
  results: CaseResult[],
  kind: 'practice' | 'kept-back'
): GraphCheckResult {
  const total = results.length
  const passed = results.filter((result) => result.passed).length
  const unavailable = results.filter((result) => result.unavailable).length
  const ran = results.filter((result) => !result.unavailable)
  const scores = ran.map((result) => result.score)
  const score =
    ran.length && scores.every((value) => value !== undefined)
      ? scores.reduce((sum, value) => sum + value, 0) / ran.length
      : undefined
  const failing = results.findIndex((result) => !result.passed)
  const detail = [
    `${passed} of ${total} ${kind} cases passed.`,
    ...results.map((result, index) => caseLine(index, cases[index]!, result)),
    ...(failing !== -1
      ? [
          `\nCase ${failing + 1} output:\n${results[failing]!.detail.slice(-GRAPH_CHECK_DETAIL_CHARS / 2)}`
        ]
      : [])
  ].join('\n')
  return {
    passed: total > 0 && passed === total,
    ...(score !== undefined ? { score } : {}),
    detail,
    cases: {
      total,
      passed,
      unavailable,
      passing: results.flatMap((result, index) => (result.passed ? [index] : []))
    },
    ...(total > 0 && unavailable === total ? { unavailable: true as const } : {})
  }
}
