import {
  readFetchResponseJsonWithinLimit,
  FetchResponseBodyTooLargeError
} from '../../shared/fetch-response-body'
import {
  DECISION_MAX_RESPONSE_BYTES,
  DecisionProviderError,
  snapshotDecisionRequest,
  validateDecisionResult,
  type DecisionRequest,
  type DecisionResult,
  type StructuredDecisionProvider
} from '../../shared/structured-decisions'
import {
  LAYA_MODEL,
  LAYA_PROTOCOL,
  LAYA_SHADOW_URL,
  LAYA_MAX_QUESTIONS,
  LAYA_MAX_CHOICES
} from '../../shared/laya-shadow'

export class LayaDecisionProvider implements StructuredDecisionProvider {
  readonly id = 'laya-local'
  readonly shadowOnly = true
  constructor(
    private readonly options: {
      resolveToken: () => Promise<string | undefined>
      fetch?: typeof fetch
    }
  ) {}

  async evaluate(
    request: DecisionRequest,
    { signal }: { signal: AbortSignal }
  ): Promise<DecisionResult> {
    const input = snapshotDecisionRequest(request)
    if (input.model !== undefined && input.model !== LAYA_MODEL) {
      throw new DecisionProviderError('invalid_request')
    }
    if (
      Object.keys(input.questions).length > LAYA_MAX_QUESTIONS ||
      Object.values(input.questions).some(
        (question) =>
          question.type === 'choice' && Object.keys(question.criteria).length > LAYA_MAX_CHOICES
      )
    ) {
      throw new DecisionProviderError('input_too_large')
    }
    const token = await this.options.resolveToken()
    if (signal.aborted) {
      throw new DecisionProviderError('cancelled')
    }
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      throw new DecisionProviderError('no_api_key')
    }
    let response: Response
    try {
      response = await (this.options.fetch ?? fetch)(LAYA_SHADOW_URL, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocol: LAYA_PROTOCOL,
          model: LAYA_MODEL,
          state: input.state,
          questions: input.questions
        })
      })
    } catch {
      throw new DecisionProviderError(signal.aborted ? 'cancelled' : 'network')
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new DecisionProviderError(
        response.status === 413
          ? 'input_too_large'
          : response.status === 401
            ? 'authentication'
            : 'provider_error'
      )
    }
    try {
      const wire = await readFetchResponseJsonWithinLimit<Record<string, unknown>>(
        response,
        DECISION_MAX_RESPONSE_BYTES,
        { nestingDepth: 24, structuralTokens: 40_000 }
      )
      if (
        wire?.protocol !== LAYA_PROTOCOL ||
        wire.model !== LAYA_MODEL ||
        wire.provider !== this.id
      ) {
        throw new DecisionProviderError('invalid_response')
      }
      return validateDecisionResult(wire as DecisionResult, input)
    } catch (error) {
      throw new DecisionProviderError(
        signal.aborted
          ? 'cancelled'
          : error instanceof FetchResponseBodyTooLargeError
            ? 'response_too_large'
            : 'invalid_response'
      )
    }
  }
}
