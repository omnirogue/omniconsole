import type { OrcaRuntimeService } from '../omni-runtime'
import type { OrchestrationDb } from './db'

export function notifySettledDispatchMailbox(
  runtime: Pick<OrcaRuntimeService, 'notifyMessageArrived'>,
  db: OrchestrationDb,
  dispatchId: string
): void {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch || !['completed', 'failed', 'circuit_broken'].includes(dispatch.status)) {
    return
  }
  const types = new Set(
    db
      .getUnreadMessages(`dispatch:${dispatch.id}`)
      .filter((message) => message.run_id === dispatch.run_id)
      .map((message) => message.type)
  )
  for (const type of types) {
    runtime.notifyMessageArrived(`run:${dispatch.run_id}`, type)
  }
}
