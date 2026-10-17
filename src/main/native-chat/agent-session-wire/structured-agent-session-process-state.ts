import type { StructuredAgentSessionLifetimeContext } from './structured-agent-session-host-lifetime'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export function structuredAgentSessionProcessState(
  record: AgentSessionRecord | null,
  hasProviderChild: boolean
): 'live' | 'exited' | 'unverifiable' {
  if (hasProviderChild) {
    return 'live'
  }
  // A readable journal can belong to a live TUI or a lease still awaiting reconciliation.
  return record &&
    !record.lease.unreconciled &&
    record.lease.claimStatus === 'released' &&
    record.lease.handoffStage === null &&
    record.lease.ownerProcess === null
    ? 'exited'
    : 'unverifiable'
}

export function readStructuredAgentSessionProcessState(
  context: Pick<StructuredAgentSessionLifetimeContext, 'deps' | 'sessions'>,
  sessionId: string
): 'live' | 'exited' | 'unverifiable' {
  return structuredAgentSessionProcessState(
    context.deps.store.getRecord(sessionId),
    context.sessions.get(sessionId)?.hasProviderChild === true
  )
}
