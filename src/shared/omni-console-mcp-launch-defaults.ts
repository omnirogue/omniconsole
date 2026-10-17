import { RemoteRuntimeClientError } from './remote-runtime-client-error'
import type { RuntimeOrchestrationEnvelope, RuntimeRpcResponse } from './runtime-rpc-envelope'
import type { RuntimeStatus } from './runtime-types'

export const OMNI_CONSOLE_MCP_DEFAULT_RUNTIME_CAPABILITY = 'mcp.omni-console-default.v2' as const
export const OMNI_CONSOLE_MCP_LEGACY_RUNTIME_CAPABILITY = 'mcp.omni-console-default.v1' as const

const LAUNCH_METHODS = new Set([
  'agentSession.create',
  'agentSession.ensure',
  'agentSession.hold',
  'terminal.create',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession'
])

export function isOmniConsoleMcpLaunchMethod(method: string): boolean {
  return LAUNCH_METHODS.has(method)
}

/** Only the authenticated desktop owner stamps this per-call launch hint. */
export function buildOmniConsoleMcpLaunchEnvelope(
  method: string,
  signedIn: boolean,
  envelope?: RuntimeOrchestrationEnvelope
): RuntimeOrchestrationEnvelope | undefined {
  if (signedIn && isOmniConsoleMcpLaunchMethod(method)) {
    return { ...envelope, omniConsoleMcpDefault: true }
  }
  if (!envelope || !Object.hasOwn(envelope, 'omniConsoleMcpDefault')) {
    return envelope
  }
  const remaining = { ...envelope }
  delete remaining.omniConsoleMcpDefault
  return Object.keys(remaining).length > 0 ? remaining : undefined
}

export function requireOmniConsoleMcpDefaultCapability(
  response: RuntimeRpcResponse<RuntimeStatus>
): void {
  if (!response.ok) {
    throw new RemoteRuntimeClientError(response.error.code, response.error.message, {
      data: response.error.data,
      pairingStage: 'runtime'
    })
  }
  if (
    !Array.isArray(response.result?.capabilities) ||
    !response.result.capabilities.includes(OMNI_CONSOLE_MCP_DEFAULT_RUNTIME_CAPABILITY)
  ) {
    throw new RemoteRuntimeClientError(
      'unsupported_runtime_capability',
      'Update the remote OmniConsole runtime before launching agents with the omni-console MCP default.',
      { pairingStage: 'runtime' }
    )
  }
}
