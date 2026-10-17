import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { loadProductionPrimitives } from './decision-production-primitives.mjs'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeEvaluation } from './typesafe-evaluation-metrics.mjs'
import { resolveEvaluationSuite } from './typesafe-evaluation-suites.mjs'
import {
  createEvaluationProviders,
  createLayaEvaluationProvider,
  EVALUATION_PRICING,
  EVALUATION_TIMEOUTS_MS,
  GEMINI_MODEL,
  GEMINI_URL,
  TYPESAFE_MODEL
} from './typesafe-evaluation-providers.mjs'

export const EVALUATION_LIMITS = Object.freeze({
  cases: 48,
  requests: 108,
  requestBytes: 16_384,
  elapsedMs: 12 * 60_000,
  reportedCostUsd: 0.25,
  consecutiveErrors: 3
})
const FATAL_ERRORS = new Set([
  'authentication',
  'forbidden',
  'no_api_key',
  'model_mismatch',
  'invalid_request'
])
const LAYA_URL = 'http://127.0.0.1:47831/v1/decision'
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
const OUTPUT_DIRECTORY = new URL('../../typesafe-evaluation-results/', import.meta.url)

function requireCondition(condition, code) {
  if (!condition) {
    throw new Error(code)
  }
}

export function validateEvaluationEnvironment(env) {
  requireCondition(
    env.GITHUB_ACTIONS === 'true' && env.CI === 'true' && env.TYPESAFE_EVALUATION_LIVE === '1',
    'evaluation_requires_explicit_github_execution'
  )
  requireCondition(
    env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === 'refs/heads/main-next',
    'evaluation_requires_manual_sal_next_run'
  )
  const expectedSha = env.EVALUATION_EXPECTED_SHA
  requireCondition(
    typeof expectedSha === 'string' &&
      /^[a-f0-9]{40}$/.test(expectedSha) &&
      env.GITHUB_SHA === expectedSha,
    'evaluation_commit_mismatch'
  )
  const split = env.EVALUATION_SPLIT
  requireCondition(['development', 'holdout', 'all'].includes(split), 'evaluation_invalid_split')
  const comparator = env.EVALUATION_COMPARATOR ?? 'gemini'
  requireCondition(['gemini', 'laya-local'].includes(comparator), 'evaluation_invalid_comparator')
  requireCondition(
    comparator !== 'laya-local' || (env.EVALUATION_SUITE ?? 'core') === 'core',
    'evaluation_laya_requires_core_suite'
  )
  requireCondition(
    typeof env.TYPESAFE_EVALUATION_KEY === 'string' &&
      env.TYPESAFE_EVALUATION_KEY.trim().length > 0 &&
      (comparator === 'gemini'
        ? typeof env.GEMINI_EVALUATION_KEY === 'string' &&
          env.GEMINI_EVALUATION_KEY.trim().length > 0
        : /^[a-f0-9]{64}$/.test(env.LAYA_SHADOW_TOKEN ?? '')),
    'evaluation_credentials_missing'
  )
  return { expectedSha, split, ...(comparator === 'laya-local' ? { comparator } : {}) }
}

// Deliberate allowlist: labels, split, family, rationale, and case IDs never reach a model.
export function buildEvaluationRequest(item) {
  return {
    capability: `evaluation_${item.task}`,
    state: item.state,
    questions: item.questions,
    model: TYPESAFE_MODEL
  }
}

const skipped = (code) => ({ status: 'skipped', elapsedMs: 0, errorCode: code })

function baselineObservation(item, classifyAgentTurnFailure) {
  if (item.task !== 'error_triage') {
    return skipped('not_applicable')
  }
  const started = performance.now()
  const value = classifyAgentTurnFailure(item.state.reason || undefined)
  return {
    status: 'success',
    elapsedMs: performance.now() - started,
    answers: { decision: { value } },
    usage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0
  }
}

function sumMeasured(rows, field) {
  return rows.every((row) => typeof row[field] === 'number')
    ? rows.reduce((total, row) => total + row[field], 0)
    : undefined
}

// Dependency injection is for offline tests only. The CLI below always loads production code.
export async function runEvaluation({
  cases,
  providers,
  classifyAgentTurnFailure,
  comparator = 'gemini',
  baseline,
  now = Date.now
}) {
  const baselineArm = baseline?.arm ?? 'existing_regex'
  requireCondition(
    baseline === undefined ||
      (baselineArm === 'numeric_reference' && typeof baseline.evaluate === 'function'),
    'evaluation_invalid_baseline'
  )
  requireCondition(
    Array.isArray(cases) &&
      cases.length > 0 &&
      cases.length <= EVALUATION_LIMITS.cases &&
      cases.length % 2 === 0,
    'evaluation_case_limit'
  )
  requireCondition(
    new Set(cases.map((item) => item.id)).size === cases.length,
    'evaluation_duplicate_case'
  )
  const started = now()
  const stopped = new Map()
  requireCondition(['gemini', 'laya-local'].includes(comparator), 'evaluation_invalid_comparator')
  const failures = new Map(['typesafe', comparator].map((arm) => [arm, 0]))
  let requests = 0
  let reportedCostUsd = 0
  const observations = []
  const batching = []
  async function invoke(arm, request) {
    if (stopped.has(arm)) {
      return skipped(stopped.get(arm))
    }
    if (requests >= EVALUATION_LIMITS.requests) {
      return skipped('request_budget_exhausted')
    }
    if (now() - started >= EVALUATION_LIMITS.elapsedMs) {
      return skipped('time_budget_exhausted')
    }
    if (reportedCostUsd >= EVALUATION_LIMITS.reportedCostUsd) {
      return skipped('reported_cost_budget_exhausted')
    }
    requests += 1
    let result
    try {
      result = await providers[arm](request)
    } catch {
      result = { status: 'error', elapsedMs: 0, errorCode: 'provider_error' }
    }
    if (Number.isFinite(result.estimatedCostUsd) && result.estimatedCostUsd >= 0) {
      reportedCostUsd += result.estimatedCostUsd
    }
    if (arm === 'laya-local' && result.errorCode === 'input_too_large') {
      failures.set(arm, 0)
    } else if (result.status === 'error') {
      failures.set(arm, failures.get(arm) + 1)
      if (
        FATAL_ERRORS.has(result.errorCode) ||
        failures.get(arm) >= EVALUATION_LIMITS.consecutiveErrors
      ) {
        stopped.set(arm, result.errorCode || 'consecutive_errors')
      }
    } else if (result.status === 'success') {
      failures.set(arm, 0)
    }
    return result
  }
  const schedule = buildCounterbalancedSchedule(cases.length, 'typesafe', comparator)
  for (const [index, item] of cases.entries()) {
    const request = buildEvaluationRequest(item)
    observations.push({
      caseId: item.id,
      arm: baselineArm,
      ...(baseline
        ? baseline.evaluate(request)
        : baselineObservation(item, classifyAgentTurnFailure))
    })
    for (const arm of schedule[index]) {
      observations.push({
        caseId: item.id,
        arm,
        ...(await invoke(arm, request))
      })
    }
  }
  // Four DEVELOPMENT cases only: paired batching economics, not four new quality examples.
  const batchingCases = cases
    .filter(
      (item) =>
        (item.task === 'evidence_support' || item.batchComparison === true) &&
        item.split === 'development'
    )
    .slice(0, 4)
  if (batchingCases.length > 0 && batchingCases.length % 2 === 0) {
    const batchSchedule = buildCounterbalancedSchedule(batchingCases.length, 'batch', 'sequential')
    for (const [index, item] of batchingCases.entries()) {
      for (const mode of batchSchedule[index]) {
        const request = buildEvaluationRequest(item)
        const rows = mode === 'batch' ? [await invoke('typesafe', request)] : []
        if (mode === 'sequential') {
          for (const [id, question] of Object.entries(request.questions)) {
            rows.push(await invoke('typesafe', { ...request, questions: { [id]: question } }))
          }
        }
        const allSuccessful = rows.every((row) => row.status === 'success')
        batching.push({
          caseId: item.id,
          mode,
          order: batchSchedule[index].indexOf(mode),
          status: allSuccessful
            ? 'success'
            : rows.some((row) => row.status === 'error')
              ? 'error'
              : 'skipped',
          elapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0),
          attempts: rows.filter((row) => row.status !== 'skipped').length,
          answers: allSuccessful ? Object.assign({}, ...rows.map((row) => row.answers)) : {},
          estimatedCostUsd: sumMeasured(rows, 'estimatedCostUsd'),
          calls: rows
        })
      }
    }
  }
  return {
    observations,
    batching,
    requests,
    reportedCostUsd,
    stopReasons: Object.fromEntries(stopped)
  }
}

export function createBudgetedFetch(fetcher = globalThis.fetch, comparator = 'gemini') {
  let calls = 0
  return async (url, options) => {
    requireCondition(
      [TYPESAFE_URL, comparator === 'laya-local' ? LAYA_URL : GEMINI_URL].includes(url) &&
        options?.method === 'POST' &&
        options.redirect === 'error',
      'evaluation_invalid_destination'
    )
    requireCondition(
      typeof options.body === 'string' &&
        Buffer.byteLength(options.body, 'utf8') <= EVALUATION_LIMITS.requestBytes,
      'evaluation_input_budget'
    )
    requireCondition(++calls <= EVALUATION_LIMITS.requests, 'evaluation_request_budget')
    return fetcher(url, options)
  }
}

async function main() {
  const configuration = validateEvaluationEnvironment(process.env)
  const comparator = configuration.comparator ?? 'gemini'
  const suite = resolveEvaluationSuite(process.env.EVALUATION_SUITE ?? 'core')
  const production = await loadProductionPrimitives()
  const cases = suite.cases.filter(
    (item) => configuration.split === 'all' || item.split === configuration.split
  )
  // Validate all prompts before either provider receives the first paid request.
  for (const item of cases) {
    production.snapshotDecisionRequest(buildEvaluationRequest(item))
  }
  const providers = createEvaluationProviders({
    ...production,
    typesafeKey: process.env.TYPESAFE_EVALUATION_KEY,
    geminiKey: process.env.GEMINI_EVALUATION_KEY,
    fetch: createBudgetedFetch(globalThis.fetch, comparator)
  })
  if (comparator === 'laya-local') {
    providers['laya-local'] = createLayaEvaluationProvider({
      ...production,
      token: process.env.LAYA_SHADOW_TOKEN,
      fetch: createBudgetedFetch(globalThis.fetch, comparator)
    })
  }
  const startedAt = new Date().toISOString()
  const result = await runEvaluation({
    cases,
    providers,
    comparator,
    baseline: suite.baseline,
    classifyAgentTurnFailure: production.classifyAgentTurnFailure
  })
  const simulation = suite.simulate?.()
  const report = {
    schemaVersion: 1,
    suite: suite.id,
    commit: configuration.expectedSha,
    split: configuration.split,
    corpusSha256: createHash('sha256').update(JSON.stringify(suite.cases)).digest('hex'),
    startedAt,
    finishedAt: new Date().toISOString(),
    models: {
      typesafe: TYPESAFE_MODEL,
      [comparator]: comparator === 'laya-local' ? production.layaModel : GEMINI_MODEL,
      [suite.baselineArm]: suite.baselineDescription
    },
    limits: EVALUATION_LIMITS,
    timeoutsMs: EVALUATION_TIMEOUTS_MS,
    pricing: EVALUATION_PRICING,
    limitations: [
      'Authored synthetic cases and labels; not independent human-labelled production data.',
      'Predeclared holdout prompt cases, not blinded authors or representative workload sampling.',
      'Related cases share families; Wilson intervals are descriptive and ignore family dependence.',
      'One observation per case/arm; latency percentiles are descriptive, not stable service SLAs.',
      'No automatic promotion; model confidence is not calibrated evidence or action authority.',
      'Reported-cost stop excludes unknown charges and is not a guaranteed billing cap.',
      'Batching repeats development cases; never count repeats as additional independent cases.',
      'Context relevance does not establish downstream task quality or safe context compression.',
      'Laya rejects truncated prompts. Unsupported inputs count as failures, not excluded cases.',
      'Laya has unknown hosting cost; zero output tokens do not imply zero compute cost.',
      ...suite.limitations
    ],
    ...result,
    summary: summarizeEvaluation(cases, result.observations, {
      baselineArm: suite.baselineArm,
      rightArm: comparator
    }),
    ...(suite.summarize ? { experimentSummary: suite.summarize(cases, result.observations) } : {}),
    ...(simulation ? { simulation } : {})
  }
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true })
  writeFileSync(new URL('report.json', OUTPUT_DIRECTORY), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600
  })
  const incomplete =
    result.observations.some((row) =>
      row.arm === suite.baselineArm ? row.status === 'error' : row.status !== 'success'
    ) || result.batching.some((row) => row.status !== 'success')
  const message = [
    '# Typesafe experiment — not a production promotion',
    '',
    `Commit: ${configuration.expectedSha}; suite: ${suite.id}; split: ${configuration.split}; cases: ${cases.length}.`,
    `Provider attempts: ${result.requests}; completeness: ${incomplete ? 'INCOMPLETE (inspect errors/skips)' : 'complete'}.`,
    '',
    'Metadata-only results are in report.json. No prompts, credentials, or provider error bodies are logged.',
    'Synthetic correctness is not proof of production value; consult the protocol and source evidence.',
    ''
  ].join('\n')
  writeFileSync(new URL('summary.md', OUTPUT_DIRECTORY), message, { mode: 0o600 })
  // Only aggregate, preformatted metadata goes to logs and the GitHub summary.
  process.stdout.write(message)
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, message, { flag: 'a' })
  }
  if (incomplete) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write(
      'Typesafe evaluation stopped safely; inspect workflow configuration or sanitized result artifact.\n'
    )
    process.exitCode = 1
  })
}
