import { randomUUID } from 'node:crypto'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../omni-runtime'
import { RpcDispatcher } from '../rpc/dispatcher'
import { ALL_RPC_METHODS } from '../rpc/methods'

export class BuildReviewRpcError extends Error {
  readonly code: string
  readonly data: unknown
  constructor(method: string, code: string, message: string, data?: unknown) {
    super(`${method}: ${message}`)
    this.name = 'BuildReviewRpcError'
    this.code = code
    this.data = data
  }
}

export type OrchestrationCaller = <T>(
  method: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal; requestId?: string }
) => Promise<T>

/**
 * In-process orchestration client for the desktop coordinator. It goes through
 * the same dispatcher the CLI uses so every fence, receipt and lifecycle rule
 * applies; the envelope carries the contract version the migration fence
 * demands and a fresh request id per mutation.
 */
export function createOrchestrationCaller(runtime: OrcaRuntimeService): OrchestrationCaller {
  const dispatcher = new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS })
  return async <T>(
    method: string,
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; requestId?: string }
  ): Promise<T> => {
    const response = await dispatcher.dispatch(
      {
        id: `build-review:${randomUUID()}`,
        authToken: 'desktop-ipc',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: options?.requestId ?? randomUUID()
      },
      { clientId: 'desktop-build-review', clientKind: 'runtime', signal: options?.signal }
    )
    if (!response.ok) {
      throw new BuildReviewRpcError(
        method,
        response.error.code,
        response.error.message,
        response.error.data
      )
    }
    return response.result as T
  }
}
