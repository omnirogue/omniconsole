import { isOrchestrationMutation } from '../../shared/orchestration-rpc-contract'
import { buildOmniConsoleMcpLaunchEnvelope } from '../../shared/omni-console-mcp-launch-defaults'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import { isOmniConsoleMcpSignedIn } from '../mcp/omni-console-mcp-auth'

export function resolveRuntimeRequestEnvelope(
  userDataPath: string,
  method: string,
  params: unknown,
  envelope?: RuntimeOrchestrationEnvelope
): {
  requestEnvelope: RuntimeOrchestrationEnvelope | undefined
  sharedControlEnvelope: RuntimeOrchestrationEnvelope | undefined
} {
  const requestEnvelope = buildOmniConsoleMcpLaunchEnvelope(
    method,
    isOmniConsoleMcpSignedIn(userDataPath),
    envelope
  )
  return {
    requestEnvelope,
    sharedControlEnvelope:
      requestEnvelope &&
      method.startsWith('orchestration.') &&
      !isOrchestrationMutation(method, params)
        ? requestEnvelope
        : undefined
  }
}
