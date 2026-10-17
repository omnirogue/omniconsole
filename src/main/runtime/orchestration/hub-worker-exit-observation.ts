import type { OrchestrationObservationInput } from '../../../shared/orchestration-execution-observation'
import type { OrchestrationDb } from './db/orchestration-db'

/** Completed assignments still belong to the exact process whose host observed an exit. */
export function getHubWorkerExitObservations(
  db: OrchestrationDb,
  processIncarnation: string,
  detail: string
): OrchestrationObservationInput[] {
  const dispatches = db.db
    .prepare(
      `SELECT id, run_id FROM dispatch_contexts
       WHERE process_incarnation = ? AND hub_task_id IS NOT NULL`
    )
    .all(processIncarnation) as { id: string; run_id: string }[]
  return dispatches.map((dispatch) => ({
    runId: dispatch.run_id,
    workerDispatchId: dispatch.id,
    event: 'worker_exit',
    detail
  }))
}
