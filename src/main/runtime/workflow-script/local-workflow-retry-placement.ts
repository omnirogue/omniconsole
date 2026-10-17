import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import type { LocalWorkflowHostOptions } from './local-workflow-host-options'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'

/** Retry keeps accepted calls, but takes fresh placement after an automatic dispatch failed. */
export async function retryLocalWorkflowPlacement(
  store: WorkflowCheckpointStore,
  options: LocalWorkflowHostOptions,
  executionId: string,
  fence: number
): Promise<void> {
  const snapshot = store.inspect(executionId, fence).snapshot as LocalWorkflowHostSnapshot
  const old = snapshot.host?.placement
  let placement
  if (old?.mode === 'dispatched-seats' && old.choice !== 'named' && options.place) {
    placement = await options.place('fleet', undefined, old.host ? [old.host.machine] : [])
    if (placement.mode === 'dispatched-seats') {
      if (!options.dispatch) {
        throw new Error('This runtime cannot dispatch workflow seats.')
      }
      placement = await options.dispatch(placement, snapshot)
    } else {
      await options.preflight?.({ ...snapshot, host: { ...snapshot.host, placement } })
    }
  }
  try {
    store.retryFailed(executionId, fence, placement)
  } catch (error) {
    if (placement) {
      await options.discardDispatch?.(placement)
    }
    throw error
  }
}

export function assertWorkflowRetryAllowed(working: boolean, active: boolean): void {
  if (working) {
    throw new Error(
      'A writable Dispatch cannot be replaced. Start a new workflow after reconciling its result.'
    )
  }
  if (active) {
    throw new Error('Workflow is still settling its failed calls.')
  }
}
