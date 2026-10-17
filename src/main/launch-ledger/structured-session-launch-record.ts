import { randomUUID } from 'node:crypto'
import { normalizeLaunchCause, type LaunchCause } from '../../shared/launch-cause'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AttachFlowInput } from '../native-chat/agent-session-wire/structured-agent-session-attach-flow'
import { hashLaunchCorrelationId } from './launch-ledger-identifiers'
import { recordLaunch, type LaunchLedgerInput } from './launch-ledger'
import { attemptLaunchProvenance } from './launch-provenance-guard'

/** The adapter's receipt proves execution even if later lease or journal publication fails. */
export function recordStructuredSessionAcquisition(
  input: Pick<AttachFlowInput, 'params' | 'authority'>,
  record: AgentSessionRecord,
  acquired: AgentSessionAcquisition
): void {
  attemptLaunchProvenance(
    'structured-agent-session',
    () => {
      if (acquired.launchRecordedAtExecutionBoundary) {
        return
      }
      const cause = normalizeLaunchCause(input.authority.launchCause)
      recordLaunch({
        pipeline: 'structured-agent-session',
        launchId: randomUUID(),
        ptyId: null,
        worktreeId: record.location.workspaceId,
        agent: input.params.agent,
        incarnationId: acquired.acquisitionGeneration,
        cause: normalizeLaunchCause({
          ...cause,
          reference: { ...cause.reference, agentSessionId: record.sessionId },
          requestId: cause.requestId ?? input.params.envelope.clientOperationId,
          clientMutationIdHash:
            cause.clientMutationIdHash ??
            hashLaunchCorrelationId(input.params.envelope.clientOperationId)
        }),
        hasStartupCommand: false,
        process: record.lease.ownerProcess === null ? 'created' : 'attached'
      })
    },
    undefined
  )
}

export function structuredSessionLaunchCause(
  cause: LaunchCause | undefined,
  operationId?: string
): LaunchCause {
  return attemptLaunchProvenance<LaunchCause>(
    'structured-agent-session',
    () =>
      normalizeLaunchCause({
        ...cause,
        ...(operationId
          ? {
              requestId: cause?.requestId ?? operationId,
              clientMutationIdHash:
                cause?.clientMutationIdHash ?? hashLaunchCorrelationId(operationId)
            }
          : {})
      }),
    { trigger: 'unknown' }
  )
}

export function recordStructuredSessionStart(
  input: StructuredAgentSessionAcquireInput
): LaunchLedgerInput | null {
  return attemptLaunchProvenance<LaunchLedgerInput | null>(
    'structured-agent-session',
    () => {
      const cause = normalizeLaunchCause(input.launchCause)
      const receipt: LaunchLedgerInput = {
        pipeline: 'structured-agent-session',
        launchId: randomUUID(),
        ts: new Date().toISOString(),
        ptyId: null,
        worktreeId: input.identity.workspaceId,
        agent: input.identity.agent,
        cause: normalizeLaunchCause({
          ...cause,
          reference: { ...cause.reference, agentSessionId: input.identity.sessionId }
        }),
        hasStartupCommand: false,
        process: 'created'
      }
      recordLaunch(receipt)
      return receipt
    },
    null
  )
}

/** Append an outcome under the original launch id; the start receipt is never rewritten. */
export function recordStructuredSessionStartOutcome(
  receipt: LaunchLedgerInput | null,
  outcome: { incarnationId?: string; failed?: true }
): void {
  attemptLaunchProvenance(
    'structured-agent-session',
    () => {
      if (receipt) {
        recordLaunch({
          ...receipt,
          ...(outcome.failed
            ? { outcome: 'failed-after-start' as const }
            : { incarnationId: outcome.incarnationId })
        })
      }
    },
    undefined
  )
}
