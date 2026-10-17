import {
  readFetchResponseJsonWithinLimit,
  FetchResponseBodyTooLargeError
} from '../../shared/fetch-response-body'
import {
  DECISION_MAX_RESPONSE_BYTES,
  DecisionProviderError,
  decisionIdentifierSchema,
  snapshotDecisionRequest,
  validateDecisionResult,
  type DecisionCallTag,
  type DecisionRequest,
  type DecisionResult,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import { JEV_MODEL } from '../../shared/jev-confidence'
import { jevEnvironmentDisabled, runWithJevHostControl } from './jev-host-control'
import { startJevCallAttempt } from './jev-call-rows'

export const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone'
export const TYPESAFE_DEFAULT_MODEL = JEV_MODEL
export type TypeSafeProviderOptions = {
  resolveApiKey: () => Promise<string | undefined>
  fetch?: typeof fetch
}

function retryDelay(response: Response): number | undefined {
  const milliseconds = response.headers.get('retry-after-ms')
  const seconds = response.headers.get('retry-after')
  const value =
    milliseconds !== null
      ? Number(milliseconds)
      : seconds !== null
        ? Number.isFinite(Number(seconds))
          ? Number(seconds) * 1000
          : Date.parse(seconds) - Date.now()
        : Number.NaN
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function statusError(response: Response): DecisionProviderError {
  const status = response.status
  const code =
    status === 401
      ? 'authentication'
      : status === 403
        ? 'forbidden'
        : status === 429
          ? 'rate_limited'
          : status === 529
            ? 'overloaded'
            : status === 400 || status === 422
              ? 'invalid_request'
              : 'provider_error'
  return new DecisionProviderError(
    code,
    status === 408 || status === 429 || (status >= 500 && status <= 599),
    retryDelay(response)
  )
}

export class TypeSafeDecisionProvider implements StructuredDecisionProvider {
  readonly id = 'typesafe'
  constructor(private readonly options: TypeSafeProviderOptions) {}

  /** A tagged call writes one `jev-call/1` ledger row when it settles, never delaying it. */
  async evaluate(
    request: DecisionRequest,
    { signal, call }: { signal: AbortSignal; call?: DecisionCallTag }
  ): Promise<DecisionResult> {
    const attempt = call ? startJevCallAttempt(request, call) : undefined
    try {
      const result = await runWithJevHostControl(signal, (controlledSignal) =>
        this.evaluateEnabled(request, controlledSignal, attempt)
      )
      attempt?.evaluated(result)
      return result
    } catch (error) {
      attempt?.failed(error, signal)
      throw error
    }
  }

  private async evaluateEnabled(
    request: DecisionRequest,
    signal: AbortSignal,
    attempt?: { dispatching(): void }
  ): Promise<DecisionResult> {
    const input = snapshotDecisionRequest(request)
    const model = input.model ?? TYPESAFE_DEFAULT_MODEL
    if (signal.aborted) {
      throw new DecisionProviderError('cancelled')
    }
    let key: string | undefined
    try {
      key = await this.options.resolveApiKey()
    } catch {
      throw new DecisionProviderError('no_api_key')
    }
    if (signal.aborted) {
      throw new DecisionProviderError('cancelled')
    }
    if (!key?.trim()) {
      throw new DecisionProviderError('no_api_key')
    }
    if (jevEnvironmentDisabled()) {
      throw new DecisionProviderError('disabled')
    }
    let response: Response
    try {
      attempt?.dispatching()
      response = await (this.options.fetch ?? fetch)(TYPESAFE_SYSTEM_ONE_URL, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'User-Agent': 'OmniConsole/TypeSafeDecisionProvider',
          Accept: 'application/json'
        },
        body: JSON.stringify({ state: input.state, questions: input.questions, model })
      })
    } catch {
      throw new DecisionProviderError(signal.aborted ? 'cancelled' : 'network', !signal.aborted)
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw statusError(response)
    }
    try {
      const wire = await readFetchResponseJsonWithinLimit<Record<string, unknown>>(
        response,
        DECISION_MAX_RESPONSE_BYTES,
        { nestingDepth: 24, structuralTokens: 40_000 }
      )
      if (!wire || typeof wire !== 'object' || !wire.usage || typeof wire.usage !== 'object') {
        throw new DecisionProviderError('invalid_response')
      }
      if (!['jev-latest', 'jev-preview'].includes(model) && wire.model !== model) {
        throw new DecisionProviderError('invalid_response')
      }
      const usage = wire.usage as Record<string, unknown>
      const requestId = response.headers.get('x-typesafe-request-id')
      return validateDecisionResult(
        {
          provider: this.id,
          model: wire.model,
          answers: wire.answers,
          usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
          ...(requestId && decisionIdentifierSchema.safeParse(requestId).success
            ? { requestId }
            : {})
        } as DecisionResult,
        input
      )
    } catch (error) {
      if (signal.aborted) {
        throw new DecisionProviderError('cancelled')
      }
      if (error instanceof FetchResponseBodyTooLargeError) {
        throw new DecisionProviderError('response_too_large')
      }
      throw new DecisionProviderError('invalid_response')
    }
  }
}
