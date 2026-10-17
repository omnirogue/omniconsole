import { isDeepStrictEqual } from 'node:util'
import { sessionOutcomeFolderArtifact } from '../../shared/session-outcome-folder-snapshot'
import type { ConsoleLocalResult } from '../console-workflows/console-local-execution-contract'
type ResultEvent = { id: number; kind: string; detail: Record<string, unknown> }
/** The server adds snapshot metadata to the exact result; the native runner fingerprint stays unchanged. */
export function readSessionOutcomeFolderArtifact(
  events: ResultEvent[],
  receiptEventId: number,
  result: ConsoleLocalResult,
  claim: { attempt: number; leaseGeneration: number; claimedAt: string }
) {
  const event = events.findLast(
    (entry) =>
      entry.kind === 'result' &&
      entry.id < receiptEventId &&
      entry.detail.attempt === claim.attempt &&
      entry.detail.claimed_at === claim.claimedAt
  )
  if (!event || (!('folder_snapshot' in event.detail) && !('reviewed_snapshot' in event.detail))) {
    return undefined
  }
  const expected = {
    attempt: claim.attempt,
    claimed_at: claim.claimedAt,
    lease_generation: claim.leaseGeneration,
    status: result.status,
    result_exit_code: result.result_exit_code,
    file_id: result.file_id,
    artifact_sha256: result.artifact_sha256,
    candidate_sha: result.candidate_sha,
    pr_url: result.pr_url,
    output_digest: result.output_digest,
    terminal_proof: result.terminal_proof,
    changed_files: result.changed_files,
    owned_paths_violations: result.owned_paths_violations,
    ...(result.workflow_loop_verdict ? { workflow_loop_verdict: result.workflow_loop_verdict } : {})
  }
  if (
    Object.entries(expected).some(
      ([key, value]) =>
        !isDeepStrictEqual(
          key === 'candidate_sha' ? (event.detail[key] ?? null) : event.detail[key],
          value
        )
    )
  ) {
    throw new Error(
      'The server folder artifact metadata does not match this exact acknowledged result.'
    )
  }
  return sessionOutcomeFolderArtifact.parse({
    resultEventId: event.id,
    fileId: result.file_id,
    sha256: result.artifact_sha256,
    ...(event.detail.folder_snapshot ? { folderSnapshot: event.detail.folder_snapshot } : {}),
    ...(event.detail.reviewed_snapshot ? { reviewedSnapshot: event.detail.reviewed_snapshot } : {})
  })
}
