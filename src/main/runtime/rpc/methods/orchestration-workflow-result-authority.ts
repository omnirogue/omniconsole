import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationCompatibilityEvidence } from '../../../../shared/orchestration-compatibility-evidence'
import { OrchestrationError } from '../../orchestration/orchestration-error'

export function requireWorkflowResultWorker(
  runtime: OrcaRuntimeService,
  input: {
    dispatchId: string
    from: string
    capability?: string
    callerEvidence?: OrchestrationCompatibilityEvidence
  }
) {
  // The CLI's --from is routing metadata, not proof of the calling process. A fresh
  // runtime launch is bound to the live PTY, pane, host and launch secret here;
  // restored launches still require the runtime's hook attestation.
  const caller = runtime.verifyOrchestrationCompatibilityCaller(input.callerEvidence, {
    currentRuntimeLaunchSufficient: true
  })
  if (!caller || caller.terminalHandle !== input.from) {
    throw new OrchestrationError(
      'dispatch_capability_invalid',
      'The workflow result sender is not the attested worker terminal.'
    )
  }
  const db = runtime.getOrchestrationDb()
  const dispatch = db.getDispatchContextById(input.dispatchId)
  if (!dispatch || dispatch.status !== 'dispatched') {
    throw new OrchestrationError('dispatch_inactive', 'The workflow Dispatch is not active.')
  }
  if (db.getFederatedDispatch(input.dispatchId)) {
    throw new OrchestrationError(
      'capability_unsupported',
      'Structured results from a remote workflow worker require a compatible Run-home relay.'
    )
  }
  const worker = db.getWorkerDispatch(input.dispatchId)
  if (!worker || worker.state !== 'ready') {
    throw new OrchestrationError('dispatch_inactive', 'The workflow worker is not ready.')
  }
  const authority = db.verifyDispatchCapability({
    dispatchId: input.dispatchId,
    capability: input.capability,
    paneKey: caller.paneKey,
    processIncarnation: caller.processIncarnation
  })
  if (!authority.valid) {
    throw new OrchestrationError('dispatch_capability_invalid', authority.reason)
  }
  if (
    !db.isDispatchMessageSender({
      dispatchId: input.dispatchId,
      handle: caller.terminalHandle,
      paneKey: caller.paneKey
    })
  ) {
    throw new OrchestrationError(
      'dispatch_capability_invalid',
      'The result sender does not own this Dispatch.'
    )
  }
  return db
}
