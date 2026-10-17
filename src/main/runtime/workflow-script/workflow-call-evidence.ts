import type Database from '../../sqlite/sync-database'
import { workflowEvidenceDigest } from './workflow-evidence-digest'

/** Only intact accepted values may inform a legacy program selection. */
export function readWorkflowCallEvidence(db: Database.Database, executionId: string) {
  const rows = db
    .prepare(
      'SELECT call_id,input_digest,result_json,result_digest,accepted_attempt_id,quarantined FROM local_workflow_calls WHERE execution_id=?'
    )
    .all(executionId) as {
    call_id: string
    input_digest: string
    result_json: string | null
    result_digest: string | null
    accepted_attempt_id: string | null
    quarantined: number
  }[]
  return rows.map((row) => {
    if (
      row.quarantined ||
      (row.result_json === null) !== (row.result_digest === null) ||
      (row.result_json === null) !== (row.accepted_attempt_id === null) ||
      (row.result_json !== null && workflowEvidenceDigest(row.result_json) !== row.result_digest)
    ) {
      throw new Error('Workflow call evidence is incomplete or corrupt')
    }
    return {
      callId: row.call_id,
      inputDigest: row.input_digest,
      result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown)
    }
  })
}
