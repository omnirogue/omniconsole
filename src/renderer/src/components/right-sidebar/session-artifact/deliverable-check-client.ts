import {
  DELIVERABLE_VERIFICATION_RPC,
  type DeliverableVerificationRecord
} from '../../../../../shared/deliverable-verification-types'
import {
  callRuntimeRpc,
  hasRuntimeRpcErrorCode,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'

/**
 * The deliverable check's records for one pane, newest first, from the host that ran the session.
 * Empty when that host predates the check (`method_not_found`) or on any failure.
 */
export async function listDeliverableChecks(
  target: RuntimeClientTarget,
  paneKey: string
): Promise<DeliverableVerificationRecord[]> {
  try {
    const records = await callRuntimeRpc<unknown>(target, DELIVERABLE_VERIFICATION_RPC.list, {
      paneKey
    })
    return Array.isArray(records)
      ? records.filter(
          (record): record is DeliverableVerificationRecord =>
            Boolean(record) &&
            typeof record === 'object' &&
            typeof (record as { id?: unknown }).id === 'string' &&
            Array.isArray((record as { checks?: unknown }).checks)
        )
      : []
  } catch (error) {
    if (!hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      console.warn('[deliverable-check] records unreadable', error)
    }
    return []
  }
}

/** "Not a problem": the person's own reading, kept as precision data. */
export async function markDeliverableFalseAlarm(
  target: RuntimeClientTarget,
  id: string
): Promise<boolean> {
  try {
    const marked = await callRuntimeRpc<unknown>(
      target,
      DELIVERABLE_VERIFICATION_RPC.markFalseAlarm,
      {
        id
      }
    )
    return Boolean(marked)
  } catch {
    return false
  }
}
