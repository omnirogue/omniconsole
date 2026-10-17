import { ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcResponse } from './types'

export function hubTaskBindingPreflight(
  method: string,
  params: unknown
): ((response: RuntimeRpcResponse<RuntimeStatus>) => void) | undefined {
  if (
    method !== 'orchestration.runCreate' ||
    !params ||
    typeof params !== 'object' ||
    !('hubTaskId' in params) ||
    params.hubTaskId === undefined
  ) {
    return undefined
  }
  return (response) => {
    if (response.ok === false) {
      throw new RuntimeRpcFailureError(response)
    }
    const capabilities = response.result?.capabilities
    if (
      !Array.isArray(capabilities) ||
      !capabilities.includes(ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY)
    ) {
      throw new RuntimeClientError(
        'unsupported_runtime_capability',
        'This runtime cannot bind execution to an omnios card. Update the execution host before creating a bound run.',
        { capability: ORCHESTRATION_HUB_TASK_BINDING_RUNTIME_CAPABILITY, effectsApplied: false }
      )
    }
  }
}
