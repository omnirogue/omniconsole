import { hashLaunchCorrelationId as hash } from '../../launch-ledger/launch-ledger-identifiers'
import { isLaunchRequestId } from '../../../shared/launch-identifiers'
import { normalizeLaunchCause, type LaunchCause } from '../../../shared/launch-cause'
import { callerLaunchClaims } from '../../launch-ledger/launch-caller-claims'
import type { LaunchTrigger } from '../../../shared/launch-trigger'
import type { RpcContext } from './core'

type LaunchCaller = Pick<
  RpcContext,
  'pairedDeviceId' | 'clientKind' | 'requestId' | 'orchestrationCompatibilityEvidence'
>

/** Transport identity only: clientId may be a bearer credential. */
export function rpcTerminalLaunchCause(
  context: LaunchCaller,
  trigger?: LaunchTrigger,
  operationId?: string,
  suppliedCause?: unknown
): LaunchCause {
  const evidence = context.orchestrationCompatibilityEvidence
  const fallback =
    trigger ??
    (context.clientKind === 'mobile'
      ? 'mobile-wake'
      : context.pairedDeviceId
        ? 'paired-client'
        : 'cli')
  return normalizeLaunchCause({
    trigger: fallback,
    ...callerLaunchClaims(suppliedCause),
    actor: {
      kind:
        context.clientKind === 'mobile'
          ? 'mobile'
          : context.pairedDeviceId
            ? 'paired-device'
            : 'local-cli',
      deviceId: context.pairedDeviceId,
      clientKind: context.clientKind,
      unverifiedPaneKey: evidence?.paneKey,
      unverifiedTerminalHandle: evidence?.terminalHandle
    },
    ...(typeof context.requestId === 'string'
      ? isLaunchRequestId(context.requestId)
        ? { requestId: context.requestId }
        : { requestIdHash: hash(context.requestId) }
      : {}),
    ...(typeof operationId === 'string' && operationId.length > 0
      ? { clientMutationIdHash: hash(operationId) }
      : {})
  })
}

export function orchestrationWorkerLaunchCause(taskId: string, dispatchId?: string): LaunchCause {
  return {
    trigger: 'orchestration-worker',
    reference: {
      orchestrationTaskId: taskId,
      ...(dispatchId ? { orchestrationDispatchId: dispatchId } : {})
    }
  }
}

export function federatedWorkerLaunchCause(
  context: RpcContext,
  taskId: string,
  dispatchId: string
): LaunchCause {
  return rpcTerminalLaunchCause(
    context,
    'orchestration-worker',
    context.orchestrationMutation?.requestId,
    orchestrationWorkerLaunchCause(taskId, dispatchId)
  )
}
