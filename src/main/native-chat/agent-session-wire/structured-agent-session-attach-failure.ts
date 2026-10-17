// What an attach failure does once a provider child may already exist.
//
// Lifted out of structured-agent-session-attach-flow.ts so that file stays inside
// its line budget. Past acquisition a failure no longer proves nothing started, so
// this settles the lease on whatever exit proof the cleanup could obtain.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AgentSessionAcquisitionExitUnprovenError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'

export async function settlePostAcquisitionAttachFailure(
  input: AttachFlowInput,
  record: AgentSessionRecord,
  cause: unknown
): Promise<never> {
  let cleanupError: unknown = cause
  let exitProof: 'exit-proven' | 'unproven' = 'unproven'
  try {
    await rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, cause)
  } catch (error) {
    cleanupError = error
    exitProof =
      error instanceof AgentSessionAcquisitionExitUnprovenError ? 'unproven' : 'exit-proven'
  }
  // Why: the close is awaited so the map entry is gone only once its handle is
  // released, but a failed close must not also cost the store settlement below.
  await Promise.resolve(input.onAttachFailed?.()).catch(() => undefined)
  try {
    await input.store.settleFailedPostAcquisitionAttachment({
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      spawnToken: record.lease.reservedSpawnToken ?? '',
      callerKey: input.callerKey,
      operationId: input.params.envelope.clientOperationId,
      outcome: {
        status: 'failed',
        code: 'agent_session_operation_invalid',
        message: cause instanceof Error ? cause.message : String(cause)
      },
      exitProof,
      now: input.now()
    })
  } catch (settlementError) {
    throw new AggregateError(
      [cleanupError, settlementError],
      'agent session post-acquisition attachment failure settlement failed'
    )
  }
  throw cleanupError
}
