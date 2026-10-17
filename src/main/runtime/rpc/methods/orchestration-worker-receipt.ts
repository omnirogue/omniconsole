import { consoleWorkflowClient } from '../../../backoffice/console-workflow-client'
import type { OrchestrationWorkerReadResult } from '../../../../shared/orchestration-worker-output'
import {
  attachWorkerReceiptProviderObservation,
  readWorkerOutcomeReceipt
} from '../../orchestration/worker-outcome-receipt'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { getConsoleJobBindingForDispatch } from '../../orchestration/console-job-binding'
import {
  attachWorkerReceiptCanonicalReports,
  hasWorkerReceiptCanonicalBinding
} from '../../orchestration/worker-outcome-verification'
import type { RpcContext } from '../core'
import { handleWorkerRead } from './orchestration-worker-read'

export async function handleWorkerReceipt(
  params: { dispatch: string; observeProvider?: boolean },
  context: RpcContext
) {
  const db = context.runtime.getOrchestrationDb()
  const receipt = readWorkerOutcomeReceipt(db, params.dispatch)
  const binding = getConsoleJobBindingForDispatch(db, params.dispatch)
  if (params.observeProvider) {
    try {
      const output = (await handleWorkerRead(
        { dispatch: params.dispatch, source: 'transcript', limit: 1 },
        context
      )) as OrchestrationWorkerReadResult
      attachWorkerReceiptProviderObservation(receipt, output)
    } catch (error) {
      receipt.providerRead = {
        state: 'unavailable',
        reason: error instanceof OrchestrationError ? error.code : 'provider_read_unavailable'
      }
    }
  }
  if (receipt.binding.hubTaskId) {
    if (!hasWorkerReceiptCanonicalBinding(receipt, binding)) {
      receipt.hubEvidence = {
        state: 'unavailable',
        reason: 'canonical_attempt_binding_unavailable'
      }
    } else {
      try {
        const result = await consoleWorkflowClient.getTaskLifecycle({ taskId: binding.taskId })
        if (result.ok) {
          attachWorkerReceiptCanonicalReports(receipt, binding, result.data)
        } else {
          receipt.hubEvidence = { state: 'unavailable', reason: result.error.code }
        }
      } catch {
        receipt.hubEvidence = { state: 'unavailable', reason: 'hub_lifecycle_read_unavailable' }
      }
    }
  }
  return { receipt }
}
