import type Database from '../../sqlite/sync-database'
import { workflowEvidenceDigest } from './workflow-evidence-digest'

export function commitWorkflowResult(
  db: Database.Database,
  attempt: { id: string; execution_id: string; call_id: string },
  value: unknown
): void {
  const json = JSON.stringify(value)
  const committed = db
    .prepare(
      'UPDATE local_workflow_calls SET result_json=?,result_digest=?,accepted_attempt_id=? WHERE execution_id=? AND call_id=? AND accepted_attempt_id IS NULL AND result_json IS NULL AND result_digest IS NULL AND quarantined=0'
    )
    .run(json, workflowEvidenceDigest(json), attempt.id, attempt.execution_id, attempt.call_id)
  if (Number(committed.changes) !== 1) {
    throw new Error('Workflow result commit rejected')
  }
}
