import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { classifyAgentTurnFailure } from '../../src/shared/agent-turn-failure.ts'
import { EVALUATION_CASES } from './typesafe-evaluation-corpus.mjs'
import {
  buildEvaluationRequest,
  createBudgetedFetch,
  EVALUATION_LIMITS,
  runEvaluation,
  validateEvaluationEnvironment
} from './run-typesafe-evaluation.mjs'
import { GEMINI_URL } from './typesafe-evaluation-providers.mjs'

const expectedSha = 'a'.repeat(40)
const validEnvironment = () => ({
  GITHUB_ACTIONS: 'true',
  CI: 'true',
  TYPESAFE_EVALUATION_LIVE: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main-next',
  GITHUB_SHA: expectedSha,
  EVALUATION_EXPECTED_SHA: expectedSha,
  EVALUATION_SPLIT: 'development',
  TYPESAFE_EVALUATION_KEY: 'offline-typesafe-placeholder',
  GEMINI_EVALUATION_KEY: 'offline-gemini-placeholder'
})

function success(request) {
  return {
    status: 'success',
    elapsedMs: 5,
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        {
          value: question.type === 'choice' ? Object.keys(question.criteria)[0] : 0
        }
      ])
    ),
    usage: { inputTokens: 100, outputTokens: 2 },
    estimatedCostUsd: 0.0001
  }
}

function fakeProviders(calls = []) {
  return Object.fromEntries(
    ['typesafe', 'gemini'].map((arm) => [
      arm,
      vi.fn(async (request) => {
        calls.push({ arm, request })
        return success(request)
      })
    ])
  )
}

const casesFor = (task, split = 'development') =>
  EVALUATION_CASES.filter((item) => item.task === task && item.split === split)

describe('Typesafe live evaluation authorization', () => {
  it.each(['development', 'holdout', 'all'])('accepts explicitly authorized %s runs', (split) => {
    expect(
      validateEvaluationEnvironment({ ...validEnvironment(), EVALUATION_SPLIT: split })
    ).toEqual({ expectedSha, split })
  })

  it.each([
    ['GITHUB_ACTIONS', undefined],
    ['GITHUB_ACTIONS', 'false'],
    ['CI', undefined],
    ['CI', 'false'],
    ['TYPESAFE_EVALUATION_LIVE', undefined],
    ['TYPESAFE_EVALUATION_LIVE', 'true'],
    ['GITHUB_EVENT_NAME', 'pull_request'],
    ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_EVENT_NAME', 'schedule'],
    ['GITHUB_REF', 'refs/heads/omni-brand'],
    ['GITHUB_REF', 'refs/pull/123/merge'],
    ['GITHUB_REF', 'refs/tags/main-next'],
    ['GITHUB_SHA', 'b'.repeat(40)],
    ['GITHUB_SHA', undefined],
    ['EVALUATION_EXPECTED_SHA', 'a'.repeat(7)],
    ['EVALUATION_EXPECTED_SHA', 'A'.repeat(40)],
    ['EVALUATION_EXPECTED_SHA', `${'a'.repeat(39)}z`],
    ['EVALUATION_SPLIT', undefined],
    ['EVALUATION_SPLIT', 'production'],
    ['EVALUATION_SPLIT', 'development '],
    ['TYPESAFE_EVALUATION_KEY', undefined],
    ['TYPESAFE_EVALUATION_KEY', ''],
    ['TYPESAFE_EVALUATION_KEY', '   '],
    ['GEMINI_EVALUATION_KEY', undefined],
    ['GEMINI_EVALUATION_KEY', ''],
    ['GEMINI_EVALUATION_KEY', '\t']
  ])('rejects unauthorized %s=%s before model calls', (field, value) => {
    expect(() => validateEvaluationEnvironment({ ...validEnvironment(), [field]: value })).toThrow()
  })

  it('does not include supplied credentials in rejected authorization errors', () => {
    const env = { ...validEnvironment(), GITHUB_EVENT_NAME: 'pull_request' }
    let error
    try {
      validateEvaluationEnvironment(env)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(env.TYPESAFE_EVALUATION_KEY)
    expect(String(error)).not.toContain(env.GEMINI_EVALUATION_KEY)
  })
})

describe('evaluation request boundary', () => {
  it.each(EVALUATION_CASES)('never exposes evaluator labels for $id', (item) => {
    const request = buildEvaluationRequest(item)
    expect(request).toEqual({
      capability: `evaluation_${item.task}`,
      state: item.state,
      questions: item.questions,
      model: 'jev-1.13.0'
    })
    expect(Object.keys(request).sort()).toEqual(['capability', 'model', 'questions', 'state'])
    for (const key of ['id', 'expected', 'rationale', 'familyId', 'split', 'origin', 'task']) {
      expect(request).not.toHaveProperty(key)
    }
  })
})

describe('counterbalanced evaluation execution', () => {
  it.each([0, 1, 3, 50])('rejects %i cases before making provider calls', async (count) => {
    const providers = fakeProviders()
    const cases = Array.from({ length: count }, (_, index) => ({
      ...EVALUATION_CASES[0],
      id: `case-${index}`
    }))
    await expect(runEvaluation({ cases, providers, classifyAgentTurnFailure })).rejects.toThrow(
      'evaluation_case_limit'
    )
    expect(providers.typesafe).not.toHaveBeenCalled()
    expect(providers.gemini).not.toHaveBeenCalled()
  })

  it('rejects duplicate case IDs before making provider calls', async () => {
    const providers = fakeProviders()
    await expect(
      runEvaluation({
        cases: [EVALUATION_CASES[0], EVALUATION_CASES[0]],
        providers,
        classifyAgentTurnFailure
      })
    ).rejects.toThrow('evaluation_duplicate_case')
    expect(providers.typesafe).not.toHaveBeenCalled()
    expect(providers.gemini).not.toHaveBeenCalled()
  })

  it('alternates AB/BA launches and gives both arms the identical unlabeled input', async () => {
    const cases = casesFor('error_triage')
    const calls = []
    const providers = fakeProviders(calls)
    const result = await runEvaluation({ cases, providers, classifyAgentTurnFailure })
    expect(calls.map(({ arm }) => arm)).toEqual([
      'typesafe',
      'gemini',
      'gemini',
      'typesafe',
      'typesafe',
      'gemini',
      'gemini',
      'typesafe'
    ])
    for (let index = 0; index < cases.length; index++) {
      expect(calls[index * 2].request).toEqual(buildEvaluationRequest(cases[index]))
      expect(calls[index * 2 + 1].request).toEqual(calls[index * 2].request)
    }
    expect(providers.typesafe).toHaveBeenCalledTimes(cases.length)
    expect(providers.gemini).toHaveBeenCalledTimes(cases.length)
    expect(result.observations).toHaveLength(cases.length * 3)
  })

  it('records the actual deterministic classifier without attributing model costs', async () => {
    const cases = casesFor('error_triage', 'holdout')
    const classifier = vi.fn(classifyAgentTurnFailure)
    const result = await runEvaluation({
      cases,
      providers: fakeProviders(),
      classifyAgentTurnFailure: classifier
    })
    const baseline = result.observations.filter(({ arm }) => arm === 'existing_regex')
    expect(classifier).toHaveBeenCalledTimes(cases.length)
    expect(baseline).toHaveLength(cases.length)
    for (const observation of baseline) {
      const item = cases.find(({ id }) => id === observation.caseId)
      expect(observation.status).toBe('success')
      expect(observation.answers.decision.value).toBe(classifyAgentTurnFailure(item.state.reason))
      expect(observation.estimatedCostUsd).toBe(0)
      expect(observation.usage?.inputTokens ?? 0).toBe(0)
      expect(observation.usage?.outputTokens ?? 0).toBe(0)
    }
  })

  it('marks the regex baseline not applicable without calling it for unrelated tasks', async () => {
    const cases = casesFor('context_relevance')
    const classifier = vi.fn(() => {
      throw new Error('Baseline must not run')
    })
    const result = await runEvaluation({
      cases,
      providers: fakeProviders(),
      classifyAgentTurnFailure: classifier
    })
    expect(classifier).not.toHaveBeenCalled()
    const baseline = result.observations.filter(({ arm }) => arm === 'existing_regex')
    expect(baseline).toHaveLength(cases.length)
    for (const observation of baseline) {
      expect(observation).toMatchObject({
        status: 'skipped',
        elapsedMs: 0,
        errorCode: 'not_applicable'
      })
      expect(observation.answers).toBeUndefined()
    }
  })

  it('does not retry transient failures or change the other arm', async () => {
    const cases = casesFor('error_triage')
    const providers = fakeProviders()
    providers.typesafe.mockResolvedValueOnce({
      status: 'error',
      elapsedMs: 5,
      errorCode: 'timeout'
    })
    const result = await runEvaluation({ cases, providers, classifyAgentTurnFailure })
    expect(providers.typesafe).toHaveBeenCalledTimes(4)
    expect(providers.gemini).toHaveBeenCalledTimes(4)
    expect(result.requests).toBe(8)
    expect(result.stopReasons).toEqual({})
    expect(
      result.observations.filter(({ arm, status }) => arm === 'typesafe' && status === 'error')
    ).toHaveLength(1)
    expect(providers.typesafe.mock.calls.map(([request]) => request.state)).toEqual(
      cases.map(({ state }) => state)
    )
  })

  it.each(['authentication', 'forbidden', 'no_api_key', 'model_mismatch', 'invalid_request'])(
    'stops only the failing arm immediately after %s',
    async (errorCode) => {
      const cases = casesFor('error_triage')
      const providers = fakeProviders()
      providers.typesafe.mockResolvedValue({ status: 'error', elapsedMs: 3, errorCode })
      const result = await runEvaluation({ cases, providers, classifyAgentTurnFailure })
      expect(providers.typesafe).toHaveBeenCalledTimes(1)
      expect(providers.gemini).toHaveBeenCalledTimes(4)
      expect(result.requests).toBe(5)
      expect(result.stopReasons).toEqual({ typesafe: errorCode })
      const rows = result.observations.filter(({ arm }) => arm === 'typesafe')
      expect(rows.map(({ status }) => status)).toEqual(['error', 'skipped', 'skipped', 'skipped'])
      expect(rows.every((row) => row.errorCode === errorCode)).toBe(true)
    }
  )

  it('trips the consecutive-error limit without turning skips into attempted requests', async () => {
    const providers = fakeProviders()
    providers.typesafe.mockRejectedValue(new Error('sensitive upstream response body'))
    const result = await runEvaluation({
      cases: casesFor('error_triage'),
      providers,
      classifyAgentTurnFailure
    })
    expect(providers.typesafe).toHaveBeenCalledTimes(EVALUATION_LIMITS.consecutiveErrors)
    expect(providers.gemini).toHaveBeenCalledTimes(4)
    expect(result.requests).toBe(7)
    expect(result.stopReasons).toEqual({ typesafe: 'provider_error' })
    expect(JSON.stringify(result)).not.toContain('sensitive upstream response body')
    expect(
      result.observations.filter(({ arm }) => arm === 'typesafe').map(({ status }) => status)
    ).toEqual(['error', 'error', 'error', 'skipped'])
  })

  it('resets consecutive errors after success', async () => {
    const cases = casesFor('error_triage', 'holdout').slice(0, 6)
    const providers = fakeProviders()
    const timeout = { status: 'error', elapsedMs: 5, errorCode: 'timeout' }
    providers.typesafe
      .mockResolvedValueOnce(timeout)
      .mockResolvedValueOnce(timeout)
      .mockImplementationOnce(async (request) => success(request))
      .mockResolvedValueOnce(timeout)
      .mockResolvedValueOnce(timeout)
    const result = await runEvaluation({ cases, providers, classifyAgentTurnFailure })
    expect(providers.typesafe).toHaveBeenCalledTimes(6)
    expect(result.stopReasons).toEqual({})
    expect(
      result.observations.filter(({ arm }) => arm === 'typesafe').map(({ status }) => status)
    ).toEqual(['error', 'error', 'success', 'error', 'error', 'success'])
  })

  it('stops further calls at the elapsed-time budget while preserving every case observation', async () => {
    let time = 0
    const providers = fakeProviders()
    providers.typesafe.mockImplementationOnce(async (request) => {
      time = EVALUATION_LIMITS.elapsedMs
      return success(request)
    })
    const result = await runEvaluation({
      cases: casesFor('error_triage'),
      providers,
      classifyAgentTurnFailure,
      now: () => time
    })
    expect(result.requests).toBe(1)
    expect(providers.gemini).not.toHaveBeenCalled()
    expect(result.observations).toHaveLength(12)
    expect(
      result.observations.filter(
        ({ status, errorCode }) => status === 'skipped' && errorCode === 'time_budget_exhausted'
      )
    ).toHaveLength(7)
  })

  it('stops further calls once reported spend reaches the conservative budget', async () => {
    const providers = fakeProviders()
    providers.typesafe.mockImplementationOnce(async (request) => ({
      ...success(request),
      estimatedCostUsd: EVALUATION_LIMITS.reportedCostUsd
    }))
    const result = await runEvaluation({
      cases: casesFor('error_triage'),
      providers,
      classifyAgentTurnFailure
    })
    expect(result.requests).toBe(1)
    expect(result.reportedCostUsd).toBe(EVALUATION_LIMITS.reportedCostUsd)
    expect(providers.gemini).not.toHaveBeenCalled()
    expect(
      result.observations.filter(({ errorCode }) => errorCode === 'reported_cost_budget_exhausted')
    ).toHaveLength(7)
  })
})

describe('matched batching experiment', () => {
  it('counterbalances batch/sequential launches on development evidence only', async () => {
    const cases = casesFor('evidence_support')
    const calls = []
    const providers = fakeProviders(calls)
    const result = await runEvaluation({ cases, providers, classifyAgentTurnFailure })
    expect(result.batching).toHaveLength(8)
    expect(result.batching.map(({ mode }) => mode)).toEqual([
      'batch',
      'sequential',
      'sequential',
      'batch',
      'batch',
      'sequential',
      'sequential',
      'batch'
    ])
    expect(result.batching.map(({ order }) => order)).toEqual([0, 1, 0, 1, 0, 1, 0, 1])
    expect(result.observations).toHaveLength(12)
    expect(result.requests).toBe(20)
    expect(providers.typesafe).toHaveBeenCalledTimes(16)
    expect(providers.gemini).toHaveBeenCalledTimes(4)
    const extraCalls = calls.slice(cases.length * 2)
    expect(extraCalls).toHaveLength(12)
    expect(extraCalls.every(({ arm }) => arm === 'typesafe')).toBe(true)
    for (const item of cases) {
      const rows = result.batching.filter(({ caseId }) => caseId === item.id)
      const batch = rows.find(({ mode }) => mode === 'batch')
      const sequential = rows.find(({ mode }) => mode === 'sequential')
      expect(batch).toMatchObject({ status: 'success', attempts: 1, elapsedMs: 5 })
      expect(sequential).toMatchObject({ status: 'success', attempts: 2, elapsedMs: 10 })
      expect(batch.answers).toEqual(sequential.answers)
      expect(Object.keys(batch.answers).sort()).toEqual(Object.keys(item.questions).sort())
      expect(batch.estimatedCostUsd).toBeCloseTo(0.0001)
      expect(sequential.estimatedCostUsd).toBeCloseTo(0.0002)
      const sameState = extraCalls.filter(({ request }) => request.state === item.state)
      expect(sameState.map(({ request }) => Object.keys(request.questions).length).sort()).toEqual([
        1, 1, 2
      ])
      expect(sameState.every(({ request }) => !Object.hasOwn(request, 'expected'))).toBe(true)
    }
  })

  it('does not reuse holdout observations for additional batching runs', async () => {
    const cases = EVALUATION_CASES.filter(({ split }) => split === 'holdout')
    const providers = fakeProviders()
    const result = await runEvaluation({ cases, providers, classifyAgentTurnFailure })
    expect(result.batching).toEqual([])
    expect(result.requests).toBe(72)
    expect(result.observations).toHaveLength(108)
  })

  it('keeps full-corpus calls within the declared cap and repeated batching outside quality rows', async () => {
    const providers = fakeProviders()
    const result = await runEvaluation({
      cases: EVALUATION_CASES,
      providers,
      classifyAgentTurnFailure
    })
    expect(result.requests).toBe(EVALUATION_LIMITS.requests)
    expect(result.requests).toBe(108)
    expect(providers.typesafe).toHaveBeenCalledTimes(60)
    expect(providers.gemini).toHaveBeenCalledTimes(48)
    expect(result.observations).toHaveLength(144)
    expect(result.batching).toHaveLength(8)
    expect(new Set(result.observations.map(({ arm, caseId }) => `${arm}:${caseId}`)).size).toBe(144)
  })

  it('retains partial-failure metadata without presenting partial answers or unknown cost as complete', async () => {
    const cases = casesFor('evidence_support')
    const providers = fakeProviders()
    let calls = 0
    providers.typesafe.mockImplementation(async (request) => {
      calls += 1
      if (calls === 6) {
        return { status: 'error', elapsedMs: 5, errorCode: 'timeout' }
      }
      return success(request)
    })
    const result = await runEvaluation({ cases, providers, classifyAgentTurnFailure })
    const row = result.batching.find(
      ({ caseId, mode }) => caseId === cases[0].id && mode === 'sequential'
    )
    expect(row).toMatchObject({ status: 'error', attempts: 2, elapsedMs: 10, answers: {} })
    expect(row.estimatedCostUsd).toBeUndefined()
    expect(row.calls.map(({ status }) => status)).toEqual(['error', 'success'])
    expect(result.requests).toBe(20)
  })
})

describe('live fetch request firewall', () => {
  const typesafeUrl = 'https://api.typesafe.ai/v1/systemone'
  const options = () => ({ method: 'POST', redirect: 'error', body: '{}' })

  it.each([typesafeUrl, GEMINI_URL])('allows the exact pinned destination %s', async (url) => {
    const response = { status: 200 }
    const fetcher = vi.fn(async () => response)
    const request = options()
    await expect(createBudgetedFetch(fetcher)(url, request)).resolves.toBe(response)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, request)
  })

  it.each([
    'http://api.typesafe.ai/v1/systemone',
    'https://api.typesafe.ai/v1/systemone/',
    'https://api.typesafe.ai/v1/systemone?key=never-forward',
    'https://api.typesafe.ai.invalid/v1/systemone',
    'https://example.com',
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
  ])('rejects an unapproved destination without fetching: %s', async (url) => {
    const fetcher = vi.fn()
    await expect(createBudgetedFetch(fetcher)(url, options())).rejects.toThrow(
      'evaluation_invalid_destination'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    { method: 'GET', redirect: 'error', body: '{}' },
    { method: 'POST', redirect: 'follow', body: '{}' },
    { method: 'POST', body: '{}' },
    { redirect: 'error', body: '{}' },
    undefined
  ])('requires POST and redirect rejection', async (request) => {
    const fetcher = vi.fn()
    await expect(createBudgetedFetch(fetcher)(typesafeUrl, request)).rejects.toThrow(
      'evaluation_invalid_destination'
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, 'x'.repeat(EVALUATION_LIMITS.requestBytes + 1), 'é'.repeat(8193)])(
    'rejects non-string and over-budget UTF-8 bodies',
    async (body) => {
      const fetcher = vi.fn()
      await expect(
        createBudgetedFetch(fetcher)(typesafeUrl, { ...options(), body })
      ).rejects.toThrow('evaluation_input_budget')
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it('accepts the exact byte limit', async () => {
    const fetcher = vi.fn(async () => ({ status: 200 }))
    await createBudgetedFetch(fetcher)(typesafeUrl, {
      ...options(),
      body: 'é'.repeat(EVALUATION_LIMITS.requestBytes / 2)
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('enforces one shared 108-request cap across both destinations', async () => {
    const fetcher = vi.fn(async () => ({ status: 200 }))
    const guarded = createBudgetedFetch(fetcher)
    for (let index = 0; index < EVALUATION_LIMITS.requests; index++) {
      await guarded(index % 2 ? GEMINI_URL : typesafeUrl, options())
    }
    await expect(guarded(typesafeUrl, options())).rejects.toThrow('evaluation_request_budget')
    await expect(guarded(GEMINI_URL, options())).rejects.toThrow('evaluation_request_budget')
    expect(fetcher).toHaveBeenCalledTimes(EVALUATION_LIMITS.requests)
  })
})

describe('manual GitHub experiment isolation', () => {
  const workflow = parse(
    readFileSync(
      new URL('../../.github/workflows/typesafe-evaluation.yml', import.meta.url),
      'utf8'
    )
  )

  it('has no scheduled or automatic paid-inference trigger and is read-only', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'workflow_dispatch'])
    expect(workflow.on.pull_request.paths).toEqual(['.github/workflows/typesafe-evaluation.yml'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.concurrency).toEqual({
      group: 'typesafe-evaluation',
      'cancel-in-progress': false
    })
    expect(workflow.jobs.registration.if).toBe("github.event_name == 'pull_request'")
    expect(workflow.jobs.registration.environment).toBeUndefined()
    expect(JSON.stringify(workflow.jobs.registration)).not.toContain('secrets.')
    expect(workflow.jobs.registration.steps).toHaveLength(1)
    expect(workflow.jobs.registration.steps[0].run).toMatch(/^echo /)
  })

  it('restricts credentials to the manually dispatched, commit-pinned main-next inference step', () => {
    const job = workflow.jobs.evaluate
    expect(job.if).toBe(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main-next'"
    )
    expect(job.environment).toBe('typesafe-evaluation')
    expect(job['timeout-minutes']).toBe(20)
    expect(job.env).toBeUndefined()
    expect(job.steps).toHaveLength(9)
    const [pin, checkout, install, cliPackage, inference, python, provision, laya, artifact] =
      job.steps
    expect(pin.env).toEqual({
      EXPECTED_SHA: '${{ inputs.expected_sha }}',
      EVALUATION_SUITE: '${{ inputs.suite }}',
      EVALUATION_COMPARATOR: '${{ inputs.comparator }}'
    })
    expect(pin.run).toContain('"$EXPECTED_SHA" == "$GITHUB_SHA"')
    expect(pin.run).toContain(
      '"$EVALUATION_COMPARATOR" != \'laya-local\' || "$EVALUATION_SUITE" == \'core\''
    )
    expect(checkout.with['persist-credentials']).toBe(false)
    expect(install.uses).toBe('./.github/actions/install-node-dependencies')
    expect(install.with['native-runtime']).toBe('none')
    expect(cliPackage.if).toBe("inputs.suite == 'decision_recipes'")
    expect(cliPackage.run).toBe('node config/scripts/build-decision-recipes.mjs')
    expect(cliPackage.env).toBeUndefined()
    expect(inference.if).toBe("inputs.comparator != 'laya-local'")
    for (const step of [python, provision, laya]) {
      expect(step.if).toBe("inputs.comparator == 'laya-local'")
    }
    expect(inference.env).toEqual({
      TYPESAFE_EVALUATION_LIVE: '1',
      EVALUATION_EXPECTED_SHA: '${{ inputs.expected_sha }}',
      EVALUATION_SPLIT: '${{ inputs.split }}',
      EVALUATION_SUITE: '${{ inputs.suite }}',
      TYPESAFE_EVALUATION_KEY: '${{ secrets.TYPESAFE_EVALUATION_KEY }}',
      GEMINI_EVALUATION_KEY: '${{ secrets.GEMINI_EVALUATION_KEY }}'
    })
    expect(inference.run).toContain('config/scripts/run-typesafe-evaluation.mjs')
    expect(artifact.if).toBe('always()')
    expect(artifact.with.path).toBe('typesafe-evaluation-results/')
    for (const step of [pin, checkout, install, cliPackage, python, provision, artifact]) {
      expect(JSON.stringify(step)).not.toContain('secrets.')
    }
  })
})
