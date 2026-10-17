// The durable half of `run-show --queue`: one bounded, read-only pass over a Run's unfinished
// Tasks with each one's newest Dispatch. No row is written and no lifecycle is reconciled here.

import type { OrchestrationDb } from '../orchestration-db'
import { exposeUtcTimestamp } from '../utc-timestamp'

export type RunQueueTaskRow = {
  task_id: string
  task_title: string | null
  display_name: string | null
  spec: string
  task_status: string
  dispatch_id: string | null
  dispatch_status: string | null
  dispatched_at: string | null
  last_heartbeat_at: string | null
  last_failure: string | null
  assignee_handle: string | null
  worker_state: string | null
  worker_stage: string | null
  worker_error: string | null
  worker_updated_at: string | null
  agent_terminal_handle: string | null
  /** The connected server's saved name when the worker runs on another OmniConsole. */
  server: string | null
  terminal_release_state: string | null
  attempts: number
  open_questions: number
}

function utc(value: string | null): string | null {
  return value ? (exposeUtcTimestamp(value) ?? value) : null
}

// Why a plain function, not a prototype method: a read with one caller needs no place on the
// shared method registry.
export function readRunQueue(
  db: OrchestrationDb,
  params: { runId: string; limit: number }
): { taskCounts: Record<string, number>; unfinished: number; rows: RunQueueTaskRow[] } {
  const counts = db.db
    .prepare('SELECT status, COUNT(*) AS total FROM tasks WHERE run_id = ? GROUP BY status')
    .all(params.runId) as { status: string; total: number }[]
  const taskCounts: Record<string, number> = {}
  for (const row of counts) {
    taskCounts[row.status] = Number(row.total)
  }
  // Why newest Dispatch by rowid: a retry is a new Dispatch on the same Task, and the queue must
  // describe the attempt that is current, with the count of earlier ones beside it.
  const rows = db.db
    .prepare(
      `SELECT t.id AS task_id, t.task_title, t.display_name, t.spec, t.status AS task_status,
              d.id AS dispatch_id, d.status AS dispatch_status, d.dispatched_at,
              d.last_heartbeat_at, d.last_failure, d.assignee_handle,
              w.state AS worker_state, w.stage AS worker_stage, w.last_error AS worker_error,
              w.updated_at AS worker_updated_at, w.agent_terminal_handle,
              f.environment_name AS server,
              (SELECT r.release_state FROM worker_terminal_resources r
                WHERE r.owner_dispatch_id = d.id LIMIT 1) AS terminal_release_state,
              (SELECT COUNT(*) FROM dispatch_contexts a WHERE a.task_id = t.id) AS attempts,
              (SELECT COUNT(*) FROM question_threads q
                WHERE q.dispatch_id = d.id AND q.status = 'pending') AS open_questions
         FROM tasks t
         LEFT JOIN dispatch_contexts d ON d.rowid = (
           SELECT candidate.rowid FROM dispatch_contexts candidate
            WHERE candidate.task_id = t.id
            ORDER BY candidate.rowid DESC
            LIMIT 1
         )
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN federated_dispatches f ON f.dispatch_id = d.id
        WHERE t.run_id = ? AND t.status != 'completed'
        ORDER BY CASE t.status
                   WHEN 'dispatched' THEN 0
                   WHEN 'failed' THEN 1
                   WHEN 'blocked' THEN 2
                   WHEN 'ready' THEN 3
                   ELSE 4
                 END,
                 t.created_at
        LIMIT ?`
    )
    .all(params.runId, params.limit) as RunQueueTaskRow[]
  const unfinished = Object.entries(taskCounts)
    .filter(([status]) => status !== 'completed')
    .reduce((sum, [, total]) => sum + total, 0)
  return {
    taskCounts,
    unfinished,
    rows: rows.map((row) => ({
      ...row,
      attempts: Number(row.attempts),
      open_questions: Number(row.open_questions),
      dispatched_at: utc(row.dispatched_at),
      last_heartbeat_at: utc(row.last_heartbeat_at),
      worker_updated_at: utc(row.worker_updated_at)
    }))
  }
}
