import type { CouncilSeat } from './presets/council'
import type { OrchestrationDb } from '../orchestration/db'
import { captureWorkingAgentDispatchArtifacts } from './workflow-working-agent-dispatch-artifacts'
import { anonymousCandidatePacket } from './workflow-working-artifacts'
import { workflowEvidenceDigest } from './workflow-evidence-digest'

/** Recheck the released child's files before any candidate enters a blind packet. */
export async function workingCouncilCandidatePacket(
  db: OrchestrationDb,
  executionId: string,
  seat: CouncilSeat,
  answer: unknown,
  label: string
) {
  const call = db.db
    .prepare(
      'SELECT dispatch_id,artifact_digest,result_json,result_digest FROM local_workflow_worker_calls WHERE execution_id=? AND call_id=?'
    )
    .get(executionId, `answers/${seat.id}`) as
    | {
        dispatch_id: string | null
        artifact_digest: string | null
        result_json: string | null
        result_digest: string | null
      }
    | undefined
  if (
    !call?.dispatch_id ||
    !call.result_json ||
    workflowEvidenceDigest(call.result_json) !== call.result_digest ||
    JSON.stringify(answer) !== call.result_json
  ) {
    throw new Error('Candidate answer or Dispatch evidence changed before blind review')
  }
  const artifacts = await captureWorkingAgentDispatchArtifacts(db, call.dispatch_id)
  if (!artifacts || artifacts.digest !== call.artifact_digest) {
    throw new Error('Candidate files changed before blind review')
  }
  return anonymousCandidatePacket(answer, artifacts, label)
}
