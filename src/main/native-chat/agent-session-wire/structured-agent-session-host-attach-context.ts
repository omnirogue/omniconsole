import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { retryPendingStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'

type StructuredAgentSessionHostContextSource = Pick<
  StructuredAgentSessionAttachContext,
  | 'deps'
  | 'runtimeState'
  | 'sessions'
  | 'subscribers'
  | 'tasks'
  | 'reconcileLeases'
  | 'serialize'
  | 'now'
>

/**
 * The host's half of attaching. Why a builder beside the host: the settlement retry is the one
 * dependency the host would otherwise assemble inline, and naming it here keeps the host's
 * context method a plain list of what it hands over.
 */
export function buildStructuredAgentSessionAttachContext(
  host: StructuredAgentSessionHostContextSource
): StructuredAgentSessionAttachContext {
  return {
    ...host,
    retryPendingSettlement: (sessionId, params) =>
      retryPendingStructuredAgentSessionSettlement({
        deps: host.deps,
        sessions: host.sessions,
        sessionId,
        params,
        now: host.now
      })
  }
}
