import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DECISION_MAX_INPUT_BYTES,
  DECISION_MAX_RESPONSE_BYTES,
  type DecisionRequest
} from '../../shared/structured-decisions'
import {
  TYPESAFE_DEFAULT_MODEL,
  TYPESAFE_SYSTEM_ONE_URL,
  TypeSafeDecisionProvider
} from './typesafe-provider'

function request(): DecisionRequest {
  return {
    capability: 'editor.intent',
    routineId: 'routine-1',
    state: { text: 'Inspect this branch.' },
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Choose an operation.',
        criteria: { inspect: 'Read information.', modify: 'Change files.' }
      }
    }
  }
}

function wireResult() {
  return {
    model: 'jev-1.13.0',
    answers: {
      intent: {
        type: 'choice',
        choice: 'inspect',
        probabilities: { inspect: 0.8, modify: 0.2 },
        confidence: 0.6
      }
    },
    usage: { input_tokens: 42, output_tokens: 9 }
  }
}

function setup(response = new Response(JSON.stringify(wireResult()))) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
  const resolveApiKey = vi.fn(async () => 'fake-test-key')
  const provider = new TypeSafeDecisionProvider({ fetch: fetcher, resolveApiKey })
  const controller = new AbortController()
  return { provider, fetcher, resolveApiKey, controller, signal: controller.signal }
}

afterEach(() => vi.restoreAllMocks())

describe('TypeSafeDecisionProvider', () => {
  it('sends only the evaluation payload to the fixed HTTPS URL with an injected Bearer key', async () => {
    const response = new Response(
      JSON.stringify({ ...wireResult(), rawText: 'private-state-marker' }),
      {
        headers: { 'x-typesafe-request-id': 'req-123' }
      }
    )
    const { provider, fetcher, signal } = setup(response)
    const input = request()

    const evaluated = await provider.evaluate(input, { signal })

    expect(provider.id).toBe('typesafe')
    expect(TYPESAFE_SYSTEM_ONE_URL).toBe('https://api.typesafe.ai/v1/systemone')
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(TYPESAFE_SYSTEM_ONE_URL, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        Authorization: 'Bearer fake-test-key',
        'Content-Type': 'application/json',
        'User-Agent': 'OmniConsole/TypeSafeDecisionProvider',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        state: input.state,
        questions: input.questions,
        model: TYPESAFE_DEFAULT_MODEL
      })
    })
    expect(evaluated).toEqual({
      provider: 'typesafe',
      model: 'jev-1.13.0',
      answers: wireResult().answers,
      usage: { inputTokens: 42, outputTokens: 9 },
      requestId: 'req-123'
    })
    expect(JSON.stringify(evaluated)).not.toContain('private-state-marker')
  })

  it('honors an explicit model while reporting the resolved model returned by the provider', async () => {
    const { provider, fetcher, signal } = setup()
    const evaluated = await provider.evaluate({ ...request(), model: 'jev-latest' }, { signal })

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'jev-latest'
    })
    expect(evaluated.model).toBe('jev-1.13.0')
  })

  it.each([undefined, 'jev-1.12.0'])(
    'rejects model substitution for a pinned request: %j',
    async (model) => {
      const returnedModel = model === undefined ? 'jev-1.12.0' : 'jev-1.13.0'
      const { provider, signal } = setup(
        new Response(JSON.stringify({ ...wireResult(), model: returnedModel }))
      )

      await expect(provider.evaluate({ ...request(), model }, { signal })).rejects.toMatchObject({
        code: 'invalid_response',
        retryable: false
      })
    }
  )

  it('does not retain the caller state across asynchronous credential resolution', async () => {
    const input = request()
    const { provider, fetcher, resolveApiKey, signal } = setup()
    resolveApiKey.mockImplementation(async () => {
      input.state = 'mutated after evaluation started'
      return 'fake-test-key'
    })

    await provider.evaluate(input, { signal })

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      state: { text: 'Inspect this branch.' }
    })
  })

  it.each([undefined, '', '   '])(
    'refuses unavailable credentials without fetching: %j',
    async (key) => {
      const fetcher = vi.fn<typeof fetch>()
      const provider = new TypeSafeDecisionProvider({
        fetch: fetcher,
        resolveApiKey: async () => key
      })
      await expect(
        provider.evaluate(request(), { signal: new AbortController().signal })
      ).rejects.toMatchObject({ code: 'no_api_key', message: 'no_api_key', retryable: false })
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it('sanitizes credential lookup errors without exposing their text', async () => {
    const { provider, resolveApiKey, fetcher, signal } = setup()
    resolveApiKey.mockRejectedValue(new Error('private-vault-error fake-test-key'))
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'no_api_key',
      message: 'no_api_key'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects oversized input before credential lookup or HTTP work', async () => {
    const { provider, resolveApiKey, fetcher, signal } = setup()
    await expect(
      provider.evaluate({ ...request(), state: 'x'.repeat(DECISION_MAX_INPUT_BYTES) }, { signal })
    ).rejects.toMatchObject({ code: 'input_too_large' })
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'invalid_request', false],
    [401, 'authentication', false],
    [403, 'forbidden', false],
    [404, 'provider_error', false],
    [408, 'provider_error', true],
    [422, 'invalid_request', false],
    [429, 'rate_limited', true],
    [500, 'provider_error', true],
    [503, 'provider_error', true],
    [529, 'overloaded', true]
  ])('classifies HTTP %i without internally retrying', async (status, code, retryable) => {
    const { provider, fetcher, signal } = setup(
      new Response('private-provider-error', { status: Number(status) })
    )
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      name: 'DecisionProviderError',
      code,
      retryable,
      message: code
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('cancels HTTP error bodies without reading, parsing or exposing their contents', async () => {
    const pull = vi.fn()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 })
    const response = new Response(body, { status: 422 })
    const readJson = vi.spyOn(response, 'json')
    const readText = vi.spyOn(response, 'text')
    const { provider, signal } = setup(response)

    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'invalid_request',
      message: 'invalid_request'
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pull).not.toHaveBeenCalled()
    expect(readJson).not.toHaveBeenCalled()
    expect(readText).not.toHaveBeenCalled()
  })

  it.each([
    [{ 'retry-after-ms': '250', 'retry-after': '4' }, 250],
    [{ 'retry-after': '1.5' }, 1500],
    [{ 'retry-after-ms': '-1' }, undefined],
    [{ 'retry-after': 'nonsense' }, undefined]
  ])('carries valid retry delay metadata %j', async (headers, retryAfterMs) => {
    const { provider, signal } = setup(
      new Response(null, { status: 429, headers: headers as HeadersInit })
    )
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({ retryAfterMs })
  })

  it('understands HTTP date retry headers against the current clock', async () => {
    const now = Date.UTC(2026, 8, 20, 12)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const { provider, signal } = setup(
      new Response(null, {
        status: 529,
        headers: { 'retry-after': new Date(now + 3_000).toUTCString() }
      })
    )
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'overloaded',
      retryAfterMs: 3_000
    })
  })

  it.each([
    'not-json private-response-marker',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...wireResult(), usage: null }),
    JSON.stringify({ ...wireResult(), answers: {} }),
    JSON.stringify({ ...wireResult(), model: 'private model text' })
  ])('rejects malformed successful responses without exposing their body', async (text) => {
    const { provider, signal } = setup(new Response(text))
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'invalid_response',
      message: 'invalid_response',
      retryable: false
    })
  })

  it('rejects oversized declared bodies and cancels them before consuming bytes', async () => {
    const cancel = vi.fn()
    const pull = vi.fn()
    const response = new Response(new ReadableStream({ cancel, pull }, { highWaterMark: 0 }), {
      headers: { 'content-length': String(DECISION_MAX_RESPONSE_BYTES + 1) }
    })
    const { provider, signal } = setup(response)
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'response_too_large'
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(pull).not.toHaveBeenCalled()
  })

  it('enforces the byte limit when no content length is supplied', async () => {
    const { provider, signal } = setup(new Response('x'.repeat(DECISION_MAX_RESPONSE_BYTES + 1)))
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'response_too_large',
      retryable: false
    })
  })

  it('rejects deeply nested response JSON before parsing it', async () => {
    const { provider, signal } = setup(new Response(`${'['.repeat(25)}0${']'.repeat(25)}`))
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'invalid_response'
    })
  })

  it('drops request IDs that are not safe metadata identifiers', async () => {
    const { provider, signal } = setup(
      new Response(JSON.stringify(wireResult()), {
        headers: { 'x-typesafe-request-id': 'private request header text' }
      })
    )
    const evaluated = await provider.evaluate(request(), { signal })
    expect(evaluated).not.toHaveProperty('requestId')
  })

  it('sanitizes transport failures and marks them retryable', async () => {
    const { provider, fetcher, signal } = setup()
    fetcher.mockRejectedValue(new Error('private-network-error fake-test-key'))
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'network',
      message: 'network',
      retryable: true
    })
  })

  it('honors cancellation before any credential lookup', async () => {
    const { provider, controller, resolveApiKey, fetcher, signal } = setup()
    controller.abort('private-cancellation-reason')
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'cancelled',
      message: 'cancelled',
      retryable: false
    })
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('honors cancellation during credential resolution before sending HTTP', async () => {
    const { provider, controller, resolveApiKey, fetcher, signal } = setup()
    resolveApiKey.mockImplementation(async () => {
      controller.abort()
      return 'fake-test-key'
    })
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'cancelled'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('classifies aborted transport as cancelled without retaining the error or abort reason', async () => {
    const { provider, controller, fetcher, signal } = setup()
    fetcher.mockImplementation(async () => {
      controller.abort('private-abort-reason')
      throw new Error('private-transport-error')
    })
    await expect(provider.evaluate(request(), { signal })).rejects.toMatchObject({
      code: 'cancelled',
      message: 'cancelled',
      retryable: false
    })
  })

  it('classifies cancellation while reading the body without exposing the stream error', async () => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>(
      {
        pull(stream) {
          controller.abort('private-abort-reason')
          stream.error(new Error('private-stream-error'))
        }
      },
      { highWaterMark: 0 }
    )
    const { provider } = setup(new Response(body))
    await expect(provider.evaluate(request(), { signal: controller.signal })).rejects.toMatchObject(
      { code: 'cancelled', message: 'cancelled', retryable: false }
    )
  })
})
