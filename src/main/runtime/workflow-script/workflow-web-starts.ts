import type Database from '../../sqlite/sync-database'
import { WORKFLOW_WEB_STARTS_LOST } from '../orchestration/db/schema/migrate-workflow-web-starts'

/** A run's web calls that began fetching; the checkpoint row is the truth, web-calls.json a copy. */
export type WorkflowWebStarts = {
  has: (callId: string) => boolean
  /** Durable before it returns, on every platform: power loss cannot undo it. */
  begin: (callId: string, digest: string) => void
  /** Only when nothing was kept and no step read a page: the call may fetch again. */
  release: (callId: string) => void
}

// WAL with NORMAL survives an app crash, not power loss; these commits must survive both.
function durably(db: Database.Database, work: () => void): void {
  const level = db.pragma('synchronous', { simple: true }) as number
  db.pragma('synchronous = FULL')
  try {
    work()
  } finally {
    db.pragma(`synchronous = ${level}`)
  }
}

/** Whether any web call of the run began: such a run is never re-read by Retry, only recovered. */
export function workflowWebStarted(db: Database.Database, executionId: string): boolean {
  return !!db
    .prepare('SELECT 1 FROM local_workflow_web_starts WHERE execution_id=? LIMIT 1')
    .get(executionId)
}

export function workflowWebStarts(
  db: Database.Database,
  executionId: string,
  owned: () => void
): WorkflowWebStarts {
  return {
    has: (callId) => {
      owned()
      // A lost record counts for every call: none of them may read again.
      return !!db
        .prepare(
          'SELECT 1 FROM local_workflow_web_starts WHERE execution_id=? AND call_id IN (?, ?)'
        )
        .get(executionId, callId, WORKFLOW_WEB_STARTS_LOST)
    },
    begin: (callId, digest) => {
      owned()
      durably(db, () => {
        db.prepare(
          'INSERT OR REPLACE INTO local_workflow_web_starts (execution_id, call_id, digest) VALUES (?, ?, ?)'
        ).run(executionId, callId, digest)
      })
    },
    release: (callId) => {
      owned()
      durably(db, () => {
        db.prepare('DELETE FROM local_workflow_web_starts WHERE execution_id=? AND call_id=?').run(
          executionId,
          callId
        )
      })
    }
  }
}
