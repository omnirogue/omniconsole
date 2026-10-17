export const TYPESAFE_MODEL = 'jev-1.13.0'
export const GEMINI_MODEL = 'gemini-3.8-flash'
export const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
export const EVALUATION_RESPONSE_MAX_BYTES = 256 * 1024
export const EVALUATION_TIMEOUTS_MS = Object.freeze({ typesafe: 5_000, gemini: 30_000 })
export const EVALUATION_PRICING = Object.freeze({
  researchedAt: '2026-09-21',
  validThrough: '2026-12-31',
  currency: 'USD',
  basis:
    'Published standard paid-tier estimate; not an invoice. Failures may incur unknown charges.',
  cachePolicy: 'All prompt tokens charged at full input price; cached input may overestimate cost.',
  typesafe: Object.freeze({
    inputPerMillion: 0.042,
    outputPerMillion: 0,
    source: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev'
  }),
  gemini: Object.freeze({
    inputPerMillion: 0.75,
    outputPerMillion: 3.75,
    source: 'https://ai.google.dev/gemini-api/docs/pricing'
  })
})

const FORMAT_INSTRUCTION = [
  'Answer each question using its full instructions and criteria and the supplied state.',
  'Return only a JSON object whose keys are the question IDs and whose values are the answers.',
  'For choice, return one criteria key. For score, return the expected numeric score on the',
  'zero-based criteria scale. For noul, return the probability of true, from 0 to 1.',
  'Do not return explanations, confidence fields, or additional keys.'
].join(' ')
const ERROR_CODES = new Set([
  'invalid_request',
  'no_api_key',
  'authentication',
  'forbidden',
  'rate_limited',
  'overloaded',
  'timeout',
  'cancelled',
  'network',
  'provider_error',
  'invalid_response',
  'input_too_large',
  'response_too_large',
  'model_mismatch'
])
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value) => Number.isSafeInteger(value) && value >= 0
const probability = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const exactKeys = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

function failure(code) {
  return Object.assign(new Error(code), { code })
}

function safeErrorCode(error) {
  if (ERROR_CODES.has(error?.code)) {
    return error.code
  }
  if (error?.name === 'FetchResponseBodyTooLargeError') {
    return 'response_too_large'
  }
  return 'provider_error'
}

async function timedEvaluation(timeoutMs, operation) {
  const started = performance.now()
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(failure('timeout'))
    }, timeoutMs)
  })
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadline
    ])
    return { status: 'success', elapsedMs: performance.now() - started, ...result }
  } catch (error) {
    return {
      status: 'error',
      elapsedMs: performance.now() - started,
      answers: {},
      errorCode: controller.signal.aborted ? 'timeout' : safeErrorCode(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

export function estimateEvaluationCostUsd(provider, usage, now = Date.now()) {
  const date = new Date(now).toISOString().slice(0, 10)
  if (date < EVALUATION_PRICING.researchedAt || date > EVALUATION_PRICING.validThrough) {
    return undefined
  }
  const tariff = EVALUATION_PRICING[provider]
  if (!tariff || !count(usage?.inputTokens) || !count(usage?.outputTokens)) {
    return undefined
  }
  if (provider === 'gemini' && !count(usage.thinkingTokens)) {
    return undefined
  }
  const outputTokens = usage.outputTokens + (provider === 'gemini' ? usage.thinkingTokens : 0)
  if (!Number.isSafeInteger(outputTokens)) {
    return undefined
  }
  return (
    (usage.inputTokens * tariff.inputPerMillion + outputTokens * tariff.outputPerMillion) /
    1_000_000
  )
}

function costFields(provider, usage) {
  if (!usage) {
    return {}
  }
  const estimatedCostUsd = estimateEvaluationCostUsd(provider, usage)
  return { usage, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) }
}

function answerSchema(questions) {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'choice'
          ? { type: 'string', enum: Object.keys(question.criteria) }
          : {
              type: 'number',
              minimum: 0,
              maximum: question.type === 'noul' ? 1 : question.criteria.length - 1
            }
      ])
    ),
    required: Object.keys(questions),
    additionalProperties: false
  }
}

function normalizeAnswers(values, questions) {
  if (!exactKeys(values, Object.keys(questions))) {
    throw failure('invalid_response')
  }
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      const value = values[id]
      const valid =
        question.type === 'choice'
          ? typeof value === 'string' && Object.hasOwn(question.criteria, value)
          : typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= (question.type === 'noul' ? 1 : question.criteria.length - 1)
      if (!valid) {
        throw failure('invalid_response')
      }
      return [id, { value }]
    })
  )
}

function normalizeTypeSafe(result, request, model = TYPESAFE_MODEL, provider = 'typesafe') {
  if (result.model !== model) {
    throw failure('model_mismatch')
  }
  if (!exactKeys(result.answers, Object.keys(request.questions))) {
    throw failure('invalid_response')
  }
  const values = Object.fromEntries(
    Object.entries(request.questions).map(([id, question]) => {
      const answer = result.answers[id]
      if (!record(answer) || answer.type !== question.type) {
        throw failure('invalid_response')
      }
      return [id, answer[question.type]]
    })
  )
  const answers = normalizeAnswers(values, request.questions)
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'noul') {
      continue
    }
    const confidence = result.answers[id].confidence
    if (!probability(confidence)) {
      throw failure('invalid_response')
    }
    answers[id].confidence = confidence
  }
  if (!count(result.usage?.inputTokens) || !count(result.usage?.outputTokens)) {
    throw failure('invalid_response')
  }
  const usage = { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
  return { answers, model, ...costFields(provider, usage) }
}

export function createLayaEvaluationProvider({
  LayaDecisionProvider,
  layaModel,
  token,
  fetch: fetcher
}) {
  const provider = new LayaDecisionProvider({ resolveToken: async () => token, fetch: fetcher })
  return (request) =>
    timedEvaluation(5_000, async (signal) => {
      const input = { ...request, model: layaModel }
      return normalizeTypeSafe(
        await provider.evaluate(input, { signal }),
        input,
        layaModel,
        'laya-local'
      )
    })
}

function geminiUsage(metadata) {
  if (metadata === undefined) {
    return undefined
  }
  if (
    !record(metadata) ||
    !count(metadata.promptTokenCount) ||
    !count(metadata.candidatesTokenCount)
  ) {
    throw failure('invalid_response')
  }
  if (metadata.thoughtsTokenCount !== undefined && !count(metadata.thoughtsTokenCount)) {
    throw failure('invalid_response')
  }
  if (
    metadata.cachedContentTokenCount !== undefined &&
    (!count(metadata.cachedContentTokenCount) ||
      metadata.cachedContentTokenCount > metadata.promptTokenCount)
  ) {
    throw failure('invalid_response')
  }
  return {
    inputTokens: metadata.promptTokenCount,
    outputTokens: metadata.candidatesTokenCount,
    ...(metadata.thoughtsTokenCount === undefined
      ? {}
      : { thinkingTokens: metadata.thoughtsTokenCount })
  }
}

function parseGemini(wire, request) {
  if (!record(wire)) {
    throw failure('invalid_response')
  }
  if (wire.modelVersion !== GEMINI_MODEL) {
    throw failure('model_mismatch')
  }
  if (
    wire.promptFeedback?.blockReason ||
    !Array.isArray(wire.candidates) ||
    wire.candidates.length !== 1
  ) {
    throw failure('invalid_response')
  }
  const candidate = wire.candidates[0]
  if (candidate?.finishReason !== 'STOP' || !Array.isArray(candidate.content?.parts)) {
    throw failure('invalid_response')
  }
  const parts = candidate.content.parts
  if (
    parts.length !== 1 ||
    !record(parts[0]) ||
    typeof parts[0].text !== 'string' ||
    parts[0].thought === true ||
    Object.keys(parts[0]).some((key) => !['text', 'thought', 'thoughtSignature'].includes(key))
  ) {
    throw failure('invalid_response')
  }
  let values
  try {
    values = JSON.parse(parts[0].text)
  } catch {
    throw failure('invalid_response')
  }
  const answers = normalizeAnswers(values, request.questions)
  return { answers, model: GEMINI_MODEL, ...costFields('gemini', geminiUsage(wire.usageMetadata)) }
}

function httpError(status) {
  return failure(
    {
      400: 'invalid_request',
      401: 'authentication',
      403: 'forbidden',
      408: 'timeout',
      422: 'invalid_request',
      429: 'rate_limited',
      529: 'overloaded'
    }[status] ?? 'provider_error'
  )
}

export function createEvaluationProviders({
  TypeSafeDecisionProvider,
  snapshotDecisionRequest,
  readFetchResponseJsonWithinLimit,
  typesafeKey,
  geminiKey,
  fetch: fetcher = globalThis.fetch
}) {
  if (
    [
      TypeSafeDecisionProvider,
      snapshotDecisionRequest,
      readFetchResponseJsonWithinLimit,
      fetcher
    ].some((dependency) => typeof dependency !== 'function')
  ) {
    throw new TypeError(
      'Evaluation providers require the production provider, request validator, response reader, and fetch.'
    )
  }
  const typesafe = new TypeSafeDecisionProvider({
    resolveApiKey: async () => typesafeKey,
    fetch: fetcher
  })
  function snapshot(request) {
    const input = snapshotDecisionRequest(request)
    if (input.model !== undefined && input.model !== TYPESAFE_MODEL) {
      throw failure('invalid_request')
    }
    return input
  }
  return {
    typesafe: (request) =>
      timedEvaluation(EVALUATION_TIMEOUTS_MS.typesafe, async (signal) => {
        const input = snapshot(request)
        const result = await typesafe.evaluate({ ...input, model: TYPESAFE_MODEL }, { signal })
        return normalizeTypeSafe(result, input)
      }),
    gemini: (request) =>
      timedEvaluation(EVALUATION_TIMEOUTS_MS.gemini, async (signal) => {
        const input = snapshot(request)
        if (typeof geminiKey !== 'string' || !geminiKey.trim()) {
          throw failure('no_api_key')
        }
        let response
        try {
          response = await fetcher(GEMINI_URL, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              'x-goog-api-key': geminiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json'
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: FORMAT_INSTRUCTION }] },
              contents: [
                {
                  role: 'user',
                  parts: [
                    { text: JSON.stringify({ state: input.state, questions: input.questions }) }
                  ]
                }
              ],
              generationConfig: {
                maxOutputTokens: 1024,
                thinkingConfig: { thinkingLevel: 'low', includeThoughts: false },
                responseMimeType: 'application/json',
                responseJsonSchema: answerSchema(input.questions)
              }
            })
          })
        } catch {
          throw failure(signal.aborted ? 'timeout' : 'network')
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined)
          throw httpError(response.status)
        }
        let wire
        try {
          wire = await readFetchResponseJsonWithinLimit(response, EVALUATION_RESPONSE_MAX_BYTES, {
            nestingDepth: 24,
            structuralTokens: 40_000
          })
        } catch (error) {
          throw failure(
            error?.name === 'FetchResponseBodyTooLargeError'
              ? 'response_too_large'
              : 'invalid_response'
          )
        }
        return parseGemini(wire, input)
      })
  }
}
