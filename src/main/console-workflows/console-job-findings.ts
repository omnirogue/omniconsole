import type { OrchestrationDb } from '../runtime/orchestration/db'
import type { MessageRow } from '../runtime/orchestration/types'
import { reportFromMessage } from '../runtime/build-review/build-review-pipeline-state'

/** Read the settled Dispatch's committed report; prose remains evidence for the server to validate. */
export function extractConsoleJobFindings(
  db: OrchestrationDb,
  dispatchId: string,
  sanitize: (value: string) => string
): { worker_report: string } | null {
  const dispatch = db.getDispatchContextById(dispatchId)
  const worker = db.getWorkerDispatch(dispatchId)
  if (!dispatch || !worker || !['succeeded', 'failed'].includes(worker.state)) {
    return null
  }
  const message = db.db
    .prepare(`
    SELECT * FROM messages WHERE run_id = ? AND type = 'worker_done'
      AND json_extract(payload, '$.taskId') = ?
      AND json_extract(payload, '$.dispatchId') = ?
    ORDER BY sequence LIMIT 1
  `)
    .get(dispatch.run_id, dispatch.task_id, dispatchId) as MessageRow | undefined
  if (!message || message.from_handle !== dispatch.assignee_handle) {
    return null
  }
  const report = reportFromMessage(message)
  if (report.outcome !== worker.state) {
    return null
  }
  return { worker_report: sanitize(report.body).slice(-32_000) }
}
