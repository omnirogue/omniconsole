import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { snapshotDecisionRequest } from '../../src/shared/structured-decisions.ts'
import { readFetchResponseJsonWithinLimit } from '../../src/shared/fetch-response-body.ts'
import {
  createEvaluationProviders,
  estimateEvaluationCostUsd,
  EVALUATION_PRICING,
  EVALUATION_RESPONSE_MAX_BYTES,
  EVALUATION_TIMEOUTS_MS,
  GEMINI_MODEL,
  GEMINI_URL,
  TYPESAFE_MODEL
} from './typesafe-evaluation-providers.mjs'

function request() {
  return {
    capability: 'experiment.offline',
    state: { request: 'Inspect guide.txt without changing it.' },
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Classify the explicit operation.',
        criteria: { inspect: 'Read.', modify: 'Change.' }
      },
      completeness: {
        type: 'score',
        instructions: 'Assess the target specificity.',
        criteria: ['No goal.', 'Unnamed target.', 'Named target.']
      },
      requestsChange: {
        type: 'noul',
        instructions: 'Does this explicitly request a file change?',
        criteria: { true: 'Change.', false: 'No change.' }
      }
    }
  }
}

function typeSafeResult() {
  return {
    provider: 'typesafe',
    model: TYPESAFE_MODEL,
    answers: {
      intent: { type: 'choice', choice: 'inspect', confidence: 0.9 },
      completeness: { type: 'score', score: 1.8, confidence: 0.8 },
      requestsChange: { type: 'noul', noul: 0.01 }
    },
    usage: { inputTokens: 100, outputTokens: 20 }
  }
}

function geminiWire(values = { intent: 'inspect', completeness: 2, requestsChange: 0.01 }) {
  return {
    modelVersion: GEMINI_MODEL,
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(values) }] } }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 30,
      totalTokenCount: 150
    }
  }
}

function setup({
  wire = geminiWire(),
  evaluate = vi.fn(async () => typeSafeResult()),
  ...overrides
} = {}) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(wire)))
  let typeSafeOptions
  class FakeTypeSafe {
    constructor(options) {
      typeSafeOptions = options
    }
    evaluate = evaluate
  }
  const providers = createEvaluationProviders({
    TypeSafeDecisionProvider: FakeTypeSafe,
    snapshotDecisionRequest,
    readFetchResponseJsonWithinLimit,
    typesafeKey: 'fake-typesafe-key',
    geminiKey: 'fake-gemini-key',
    fetch: fetcher,
    ...overrides
  })
  return { ...providers, fetcher, evaluate, typeSafeOptions }
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-09-21T12:00:00Z') })
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Live fetch is forbidden in these offline tests.')
    })
  )
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('offline evaluation provider wrappers', () => {
  it('passes the same complete state and questions to both providers, without labels or rationale', async () => {
    const fixture = {
      request: request(),
      expected: 'secret-reference-label',
      rationale: 'secret-reference-rationale'
    }
    const { typesafe, gemini, evaluate, fetcher, typeSafeOptions } = setup()
    const left = await typesafe(fixture.request)
    const right = await gemini(fixture.request)
    expect(left.status).toBe('success')
    expect(right.status).toBe('success')
    expect(evaluate.mock.calls[0][0]).toEqual({ ...fixture.request, model: TYPESAFE_MODEL })
    expect(evaluate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(await typeSafeOptions.resolveApiKey()).toBe('fake-typesafe-key')
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe(GEMINI_URL)
    expect(options).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'x-goog-api-key': 'fake-gemini-key' }
    })
    const body = JSON.parse(options.body)
    expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({
      state: fixture.request.state,
      questions: fixture.request.questions
    })
    expect(options.body).not.toContain(fixture.expected)
    expect(options.body).not.toContain(fixture.rationale)
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingLevel: 'low', includeThoughts: false }
    })
    expect(body.generationConfig).not.toHaveProperty('candidateCount')
    expect(body.generationConfig.responseJsonSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'completeness', 'requestsChange'],
      properties: {
        intent: { type: 'string', enum: ['inspect', 'modify'] },
        completeness: { type: 'number', minimum: 0, maximum: 2 },
        requestsChange: { type: 'number', minimum: 0, maximum: 1 }
      }
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(left.answers).toEqual({
      intent: { value: 'inspect', confidence: 0.9 },
      completeness: { value: 1.8, confidence: 0.8 },
      requestsChange: { value: 0.01 }
    })
    expect(right.answers).toEqual({
      intent: { value: 'inspect' },
      completeness: { value: 2 },
      requestsChange: { value: 0.01 }
    })
  })

  it.each(['expected', 'rationale'])(
    'rejects leaked %s metadata before calling either provider',
    async (key) => {
      const { typesafe, gemini, evaluate, fetcher } = setup()
      const input = { ...request(), [key]: 'private-label' }
      for (const provider of [typesafe, gemini]) {
        expect(await provider(input)).toMatchObject({
          status: 'error',
          errorCode: 'invalid_request',
          answers: {}
        })
      }
      expect(evaluate).not.toHaveBeenCalled()
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, 'gemini-3.7-flash', 'gemini-3.8-flash-20260921'])(
    'rejects unverified Gemini model %s without fallback',
    async (modelVersion) => {
      const { gemini, fetcher } = setup({ wire: { ...geminiWire(), modelVersion } })
      expect(await gemini(request())).toMatchObject({
        status: 'error',
        errorCode: 'model_mismatch',
        answers: {}
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('pins TypeSafe and refuses a returned substitute', async () => {
    const evaluate = vi.fn(async () => ({ ...typeSafeResult(), model: 'jev-preview' }))
    const { typesafe } = setup({ evaluate })
    expect(await typesafe(request())).toMatchObject({
      status: 'error',
      errorCode: 'model_mismatch'
    })
    expect(evaluate.mock.calls[0][0].model).toBe(TYPESAFE_MODEL)
  })

  it('preserves only the production provider fixed failure code', async () => {
    const evaluate = vi.fn(async () => {
      throw Object.assign(new Error('private provider details'), { code: 'invalid_response' })
    })
    const result = await setup({ evaluate }).typesafe(request())
    expect(result).toMatchObject({ status: 'error', errorCode: 'invalid_response', answers: {} })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it.each([
    { intent: 'inspect', completeness: 2 },
    { intent: 'inspect', completeness: 2, requestsChange: 0, unexpected: 'secret' },
    { intent: 'inspect', completeness: 2, requestsChange: false },
    { intent: 'invented', completeness: 2, requestsChange: 0 },
    { intent: 'inspect', completeness: 3, requestsChange: 0 },
    { intent: 'inspect', completeness: 2, requestsChange: -1 },
    { intent: { value: 'inspect', confidence: 1 }, completeness: 2, requestsChange: 0 }
  ])('fails closed on Gemini answer keys or value schema mismatch: %j', async (values) => {
    const { gemini } = setup({ wire: geminiWire(values) })
    expect(await gemini(request())).toMatchObject({
      status: 'error',
      errorCode: 'invalid_response',
      answers: {}
    })
  })

  it('rejects incomplete or blocked generation without exposing raw output', async () => {
    const wire = geminiWire()
    wire.candidates[0].finishReason = 'MAX_TOKENS'
    wire.candidates[0].content.parts[0].text = 'private raw output'
    const result = await setup({ wire }).gemini(request())
    expect(result).toMatchObject({ status: 'error', errorCode: 'invalid_response' })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('counts thoughts once and prices cached prompt tokens conservatively at the full rate', async () => {
    const wire = geminiWire()
    wire.usageMetadata.cachedContentTokenCount = 80
    const result = await setup({ wire }).gemini(request())
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, thinkingTokens: 30 })
    expect(result.estimatedCostUsd).toBeCloseTo((100 * 0.75 + 50 * 3.75) / 1_000_000, 12)
    expect(EVALUATION_PRICING.cachePolicy).toContain('overestimate')
    expect((await setup().typesafe(request())).estimatedCostUsd).toBeCloseTo(
      (100 * 0.042) / 1_000_000,
      12
    )
  })

  it('keeps missing thinking usage and failure billing unknown', async () => {
    const wire = geminiWire()
    delete wire.usageMetadata.thoughtsTokenCount
    const result = await setup({ wire }).gemini(request())
    expect(result.status).toBe('success')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 })
    expect(result).not.toHaveProperty('estimatedCostUsd')
    wire.modelVersion = 'wrong-model'
    const failed = await setup({ wire }).gemini(request())
    expect(failed).not.toHaveProperty('usage')
    expect(failed).not.toHaveProperty('estimatedCostUsd')
  })

  it('expires researched estimates after December 31 without assuming future prices', () => {
    const usage = { inputTokens: 100, outputTokens: 20, thinkingTokens: 30 }
    expect(
      estimateEvaluationCostUsd('gemini', usage, Date.parse('2026-12-31T23:59:59Z'))
    ).toBeTypeOf('number')
    expect(
      estimateEvaluationCostUsd('gemini', usage, Date.parse('2027-01-01T00:00:00Z'))
    ).toBeUndefined()
    expect(
      estimateEvaluationCostUsd('typesafe', usage, Date.parse('2027-01-01T00:00:00Z'))
    ).toBeUndefined()
  })

  it('sanitizes exception messages and unknown exception codes', async () => {
    const secret = 'private-prompt fake-typesafe-key fake-gemini-key'
    const evaluate = vi.fn(async () => {
      throw Object.assign(new Error(secret), { code: secret })
    })
    const fetcher = vi.fn(async () => {
      throw new Error(secret)
    })
    const { typesafe, gemini } = setup({ evaluate, fetch: fetcher })
    const results = [await typesafe(request()), await gemini(request())]
    expect(results.map((value) => value.errorCode)).toEqual(['provider_error', 'network'])
    expect(JSON.stringify(results)).not.toContain('private')
    expect(JSON.stringify(results)).not.toContain('fake-')
  })

  it('never reads upstream HTTP error bodies and never retries', async () => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const fetcher = vi.fn(
      async () =>
        new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status: 429 })
    )
    const result = await setup({ fetch: fetcher }).gemini(request())
    expect(result).toMatchObject({ status: 'error', errorCode: 'rate_limited', answers: {} })
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uses the production bounded reader and rejects a streamed oversized body', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(EVALUATION_RESPONSE_MAX_BYTES + 1))
      },
      cancel
    })
    const response = new Response(stream)
    const reader = vi.fn(readFetchResponseJsonWithinLimit)
    const result = await setup({
      fetch: vi.fn(async () => response),
      readFetchResponseJsonWithinLimit: reader
    }).gemini(request())
    expect(result).toMatchObject({ status: 'error', errorCode: 'response_too_large' })
    expect(reader).toHaveBeenCalledWith(response, EVALUATION_RESPONSE_MAX_BYTES, {
      nestingDepth: 24,
      structuralTokens: 40_000
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it.each(['typesafe', 'gemini'])(
    'enforces the documented %s total deadline without retries',
    async (provider) => {
      let signal
      const never = new Promise(() => {})
      const evaluate = vi.fn((_request, options) => {
        signal = options.signal
        return never
      })
      const fetcher = vi.fn((_url, options) => {
        signal = options.signal
        return never
      })
      const providers = setup({ evaluate, fetch: fetcher })
      const pending = providers[provider](request())
      await vi.advanceTimersByTimeAsync(EVALUATION_TIMEOUTS_MS[provider])
      expect(await pending).toMatchObject({ status: 'error', errorCode: 'timeout', answers: {} })
      expect(signal.aborted).toBe(true)
      expect(provider === 'typesafe' ? evaluate : fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('includes a stalled response body in the Gemini deadline', async () => {
    let signal
    const fetcher = vi.fn(async (_url, options) => {
      signal = options.signal
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener(
              'abort',
              () => controller.error(new Error('private aborted body')),
              { once: true }
            )
          }
        })
      )
    })
    const pending = setup({ fetch: fetcher }).gemini(request())
    await vi.advanceTimersByTimeAsync(EVALUATION_TIMEOUTS_MS.gemini)
    const result = await pending
    expect(result).toMatchObject({ status: 'error', errorCode: 'timeout' })
    expect(signal.aborted).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('rejects an oversized declared body without pulling its stream', async () => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(EVALUATION_RESPONSE_MAX_BYTES + 1) }
    })
    const result = await setup({ fetch: vi.fn(async () => response) }).gemini(request())
    expect(result).toMatchObject({ status: 'error', errorCode: 'response_too_large' })
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects missing credentials and caller attempts to change the pinned model before HTTP work', async () => {
    const { gemini, fetcher } = setup({ geminiKey: '' })
    expect(await gemini(request())).toMatchObject({ status: 'error', errorCode: 'no_api_key' })
    expect(await gemini({ ...request(), model: 'jev-preview' })).toMatchObject({
      status: 'error',
      errorCode: 'invalid_request'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
