import { TypeSafeDecisionProvider } from './typesafe-provider'
import { resolveTypesafeCredential } from './decision-credential'
import { decisionEnvironmentKilled } from './decision-configuration'
import {
  DECISION_MAX_TIMEOUT_MS,
  DecisionProviderError,
  snapshotDecisionRequest,
  validateDecisionResult,
  type DecisionRequest,
  type DecisionResult
} from '../../shared/structured-decisions'

export type JevAdvisoryOptions = {
  evaluate?: TypeSafeDecisionProvider['evaluate']
  credential?: () => Promise<string | undefined>
  environment?: NodeJS.ProcessEnv
  disabled?: boolean
}

export type JevAdvisoryResponse =
  | { status: 'evaluated'; decision: DecisionResult; elapsedMs: number; calls: number }
  | {
      status: 'unavailable'
      reason: string
      elapsedMs: number
      calls: number
      missingAnswers: string[]
    }

/** One bounded advisory call; the deadline includes credentials and never starts a late call. */
export async function evaluateJevAdvisoryRequest(
  input: DecisionRequest,
  options: JevAdvisoryOptions = {}
): Promise<JevAdvisoryResponse> {
  const started = performance.now()
  let calls = 0
  let missingAnswers: string[] = []
  const unavailable = (reason: string): JevAdvisoryResponse => ({
    status: 'unavailable',
    reason,
    elapsedMs: performance.now() - started,
    calls,
    missingAnswers
  })
  const environment = options.environment ?? process.env
  if (
    options.disabled ||
    decisionEnvironmentKilled(environment) ||
    (environment.JEV_DECISIONS_DISABLED &&
      !['0', 'false'].includes(environment.JEV_DECISIONS_DISABLED.toLowerCase()))
  ) {
    return unavailable('disabled')
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const request = snapshotDecisionRequest(input)
    return await Promise.race([
      (async (): Promise<JevAdvisoryResponse> => {
        const key = await (options.credential ?? resolveTypesafeCredential)()
        if (controller.signal.aborted) {
          throw new DecisionProviderError('timeout')
        }
        if (!key) {
          return unavailable('no_api_key')
        }
        const provider = new TypeSafeDecisionProvider({ resolveApiKey: async () => key })
        calls++
        const response = await (options.evaluate ?? provider.evaluate.bind(provider))(request, {
          signal: controller.signal
        })
        if (controller.signal.aborted) {
          throw new DecisionProviderError('timeout')
        }
        missingAnswers = Object.keys(request.questions).filter(
          (id) => !response?.answers || !Object.hasOwn(response.answers, id)
        )
        const decision = validateDecisionResult(response, request)
        if (decision.provider !== 'typesafe' || decision.model !== request.model) {
          return unavailable('invalid_response')
        }
        return { status: 'evaluated', decision, elapsedMs: performance.now() - started, calls }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new DecisionProviderError('timeout'))
        }, DECISION_MAX_TIMEOUT_MS)
      })
    ])
  } catch (error) {
    return unavailable(
      controller.signal.aborted
        ? 'timeout'
        : error instanceof DecisionProviderError
          ? error.code
          : 'provider_error'
    )
  } finally {
    clearTimeout(timer)
  }
}
