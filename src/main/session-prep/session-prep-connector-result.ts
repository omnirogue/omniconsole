import { toSessionPrepBatchView, type SessionPrepBatchRecord } from './session-prep-records'

export function sessionPrepConnectorResult(batch: SessionPrepBatchRecord) {
  const item = batch.items[0]
  const state =
    item?.state === 'launched'
      ? 'launched'
      : item?.state === 'awaiting-reuse' ||
          item?.state === 'assigned' ||
          item?.state === 'already-covered' ||
          batch.state === 'awaiting-confirm'
        ? 'needs-review'
        : batch.state === 'failed' || item?.state === 'failed' || batch.state === 'cancelled'
          ? 'failed'
          : 'preparing'
  return {
    batchId: batch.id,
    state,
    batch: toSessionPrepBatchView(batch),
    ...(item?.launched?.nativeReceipt ? { nativeReceipt: item.launched.nativeReceipt } : {})
  }
}
