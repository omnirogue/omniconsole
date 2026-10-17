import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { ConsoleWorkflowResult } from '../../../shared/console-workflow-types'
import { pushLocalRunEvent } from './local-run-state'
import type { LocalRunNodeRuntime } from './local-run-batch'

export type LocalRunDeliveryReceipt = {
  files: { name: string; sha256: string; bytes: number }[]
  skipped: { path: string; reason: string }[]
  delivery: unknown
}

export type LocalRunDeliverer = (request: {
  taskId: string
  paths: string[]
  to: string[]
  message?: string
}) => Promise<ConsoleWorkflowResult<LocalRunDeliveryReceipt>>

// Why injected: the console client lives behind the Electron main bearer, and the
// runtime import graph must stay plain Node so the CLI can load these modules.
let deliverer: LocalRunDeliverer = async () => ({
  ok: false,
  error: {
    code: 'capability_unavailable',
    message: 'Console delivery is not available in this runtime.'
  }
})

export function setLocalRunDeliverer(next: LocalRunDeliverer): void {
  deliverer = next
}

/**
 * Hand one node's produced files to a person or a card. A refused or unreachable
 * console is reported on the run and never fails the work: the files exist on disk
 * either way, and a delivery is not what makes the node correct.
 */
export async function deliverLocalRunNode(
  snapshot: LocalRunSnapshot,
  entry: LocalRunNodeRuntime
): Promise<void> {
  const deliver = entry.node.deliver
  const paths = entry.artifacts?.producedFiles ?? []
  if (!deliver) {
    return
  }
  if (paths.length === 0) {
    pushLocalRunEvent(
      snapshot,
      'deliver',
      entry.node.id,
      'Nothing to deliver: the node produced no files.'
    )
    return
  }
  const result = await deliverer({
    taskId: deliver.taskId,
    paths,
    to: deliver.to,
    ...(deliver.message ? { message: deliver.message } : {})
  }).catch((error: unknown) => ({
    ok: false as const,
    error: { code: 'deliver_failed', message: error instanceof Error ? error.message : 'failed' }
  }))
  if (!result.ok) {
    pushLocalRunEvent(
      snapshot,
      'error',
      entry.node.id,
      `Delivery to ${deliver.taskId} was refused: ${result.error.message}`
    )
    return
  }
  entry.snapshot.deliveryId = deliver.taskId
  pushLocalRunEvent(
    snapshot,
    'deliver',
    entry.node.id,
    `Delivered ${result.data.files.length} file(s) to ${deliver.taskId} for ${deliver.to.join(', ')}${
      result.data.skipped.length > 0 ? ` (${result.data.skipped.length} skipped)` : ''
    }`
  )
}
