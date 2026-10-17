import { RuntimeRpcCallError } from './runtime-rpc-result'
import type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'

export function failedWebRuntimeTerminalCreateOutcome(
  error: unknown,
  creationRequested: boolean
): WebRuntimeTerminalCreateOutcome {
  const definitiveRefusal =
    error instanceof RuntimeRpcCallError &&
    ['invalid_argument', 'method_not_found', 'forbidden', 'selector_not_found'].includes(error.code)
  return {
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
    ...(creationRequested && !definitiveRefusal ? { creationUnverifiable: true } : {})
  }
}
