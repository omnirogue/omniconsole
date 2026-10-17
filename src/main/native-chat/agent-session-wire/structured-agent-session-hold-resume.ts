// Giving a held session its provider child back.
//
// This is the replacement for the startup resume, and the difference is only in WHO asks: the same
// eligibility rule, run when a surface binds instead of when the app launches. A write-capable hold
// must fail when acquisition is refused so the surface never mistakes a readable journal for a live
// provider child.

import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import {
  structuredAgentSessionResumeOperationId,
  structuredAgentSessionResumeParams
} from './structured-agent-session-resume-eligibility'

/**
 * Resuming because a surface took a hold. Lease reconciliation is refused first: a session whose
 * leases do not reconcile must not be resumed under someone else's hold.
 */
export async function resumeStructuredAgentSessionForHold(input: {
  sessionId: string
  deps: StructuredAgentSessionHostDeps
  now: () => number
  reconcileLeases: (sessionId: string) => Promise<{ code: string } | null>
  resolveRecovery: (sessionId: string) => Promise<unknown>
  attach: (
    params: AgentSessionAttachParams
  ) => Promise<AgentSessionMutationResult<AgentSessionAttachResult>>
}): Promise<void> {
  const unreconciled = await input.reconcileLeases(input.sessionId)
  if (unreconciled) {
    throw new Error(unreconciled.code)
  }
  await input.resolveRecovery(input.sessionId)
  await resumeHeldStructuredAgentSession(input)
}

export async function resumeHeldStructuredAgentSession(input: {
  sessionId: string
  deps: StructuredAgentSessionHostDeps
  now: () => number
  attach: (
    params: AgentSessionAttachParams
  ) => Promise<AgentSessionMutationResult<AgentSessionAttachResult>>
}): Promise<void> {
  const record = input.deps.store.getRecord(input.sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  if (!adapterSupportsRecord(input.deps.adapter, record)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const params = structuredAgentSessionResumeParams(
    record,
    structuredAgentSessionResumeOperationId(input.now())
  )
  if (!params) {
    throw new Error(
      record.lease.unreconciled
        ? 'execution_owner_reconciling'
        : record.lease.claimStatus === 'conflicted'
          ? 'agent_session_conflict'
          : 'agent_session_ownership_unknown'
    )
  }
  const attached = await input.attach(params)
  if (!attached.ok) {
    throw new Error(attached.refusal.code)
  }
}
