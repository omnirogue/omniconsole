import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { canonicalDigestJson } from '../console-workflows/console-job-digests'
import {
  sessionOutcomeCurrentInputMatches,
  sessionOutcomeCurrentWorkspaceMatches
} from './session-outcome-workflow-folder-contract'
import type { ConsoleWorkflowGraph } from '../../shared/console-workflow-types'
import type {
  SessionOutcomeStageReceipt,
  SessionOutcomeWorkflow
} from '../../shared/session-outcome-workflow'
function logicalDigest(
  files: { target_path: string; sha256: string; size_bytes: number }[]
): string {
  return createHash('sha256')
    .update(
      canonicalDigestJson(
        [...files].sort((a, b) =>
          Buffer.compare(Buffer.from(a.target_path), Buffer.from(b.target_path))
        )
      )
    )
    .digest('hex')
}
function currentDigest(
  source: NonNullable<ConsoleWorkflowGraph['nodes'][number]['current_source']>
): string {
  const files = source.files.map((file) => ({
    target_path: file.target_path,
    sha256: file.file.sha256,
    size_bytes: file.file.size_bytes
  }))
  if (!source.git) {
    return logicalDigest(files)
  }
  return createHash('sha256')
    .update(
      canonicalDigestJson({
        head_sha: source.git.head_sha,
        files,
        deleted_paths: source.git.deleted_paths
      })
    )
    .digest('hex')
}
function artifactPath(node: ConsoleWorkflowGraph['nodes'][number], path: string): boolean {
  return isDeepStrictEqual((node as unknown as Record<string, unknown>).artifact_result, {
    path,
    format: 'json',
    max_bytes: 65536
  })
}
/** A review round closes only over its frozen input or preceding verified output snapshot. */
export function verifiedSessionOutcomeCurrentReviews(
  workflow: SessionOutcomeWorkflow,
  decider: ConsoleWorkflowGraph['nodes'][number],
  participants: ConsoleWorkflowGraph['nodes'],
  reviews: SessionOutcomeStageReceipt[],
  verifiedReceipts: SessionOutcomeStageReceipt[] = []
): boolean {
  const source = decider.current_source
  const retained = workflow.currentInputs?.find(
    (input) => input.stage_key === decider.loop_stage?.stage_key
  )
  const round = Number(decider.loop_stage?.round)
  const maxRounds = Number(decider.mechanical_execution?.input.max_rounds)
  if (
    !source ||
    !retained ||
    !sessionOutcomeCurrentInputMatches(source, retained) ||
    !Number.isInteger(round) ||
    !Number.isInteger(maxRounds) ||
    round < 1 ||
    round > maxRounds ||
    maxRounds > 5 ||
    source.root_task_id !== workflow.preview.admission.filing_root_task_id ||
    source.files.some((file) => file.task_id !== source.root_task_id) ||
    participants.some(
      (participant) =>
        !isDeepStrictEqual(participant.current_source, source) ||
        !sessionOutcomeCurrentWorkspaceMatches(source, participant)
    )
  ) {
    return false
  }
  const logical = source.files.map((file) => ({
    target_path: file.target_path,
    sha256: file.file.sha256,
    size_bytes: file.file.size_bytes
  }))
  const deleted = source.git?.deleted_paths ?? []
  const selected = new Set([...logical.map((file) => file.target_path), ...deleted])
  if (
    selected.size !== logical.length + deleted.length ||
    selected.size === 0 ||
    currentDigest(source) !== source.snapshot_digest ||
    reviews.some(
      (review) =>
        !review.inputDigest ||
        review.candidateSha !== null ||
        review.branch !== null ||
        review.prUrl !== null
    )
  ) {
    return false
  }
  const recapture = Boolean(source.git) || source.mode === 'base' || maxRounds > 1
  if (!recapture) {
    return (
      round === 1 &&
      reviews.every((review) => review.verdict?.notes.includes(source.snapshot_digest))
    )
  }
  if (
    participants.some((participant) => !artifactPath(participant, 'folder-review.json')) ||
    reviews.some(
      (review) =>
        !review.folderArtifact?.reviewedSnapshot ||
        review.folderArtifact.resultEventId >= review.eventId
    )
  ) {
    return false
  }
  let expected: NonNullable<SessionOutcomeStageReceipt['folderArtifact']>['reviewedSnapshot']
  if (round === 1 && source.mode === 'review-source') {
    expected = {
      schema_version: 1,
      kind: 'current_task_files',
      snapshot_digest: source.snapshot_digest
    }
  } else {
    const producers = workflow.preview.graph.nodes.filter(
      (node) =>
        node.loop_stage?.stage_key === source.stage_key &&
        node.loop_stage?.round === round - 1 &&
        node.loop_stage?.role === (round === 1 ? 'producer' : 'repair')
    )
    if (producers.length !== 1) {
      return false
    }
    const producer = producers[0]!
    const receipt = verifiedReceipts.find(
      (entry) =>
        entry.key === producer.key &&
        entry.provider === producer.provider &&
        entry.model === producer.model
    )
    const artifact = receipt?.folderArtifact
    const snapshot = artifact?.folderSnapshot
    if (
      !receipt?.inputDigest ||
      !artifact ||
      !snapshot ||
      artifact.resultEventId >= receipt.eventId ||
      receipt.candidateSha !== null ||
      receipt.branch !== null ||
      receipt.prUrl !== null ||
      !artifactPath(producer, 'folder-snapshot.json') ||
      !isDeepStrictEqual(producer.current_source, source) ||
      !sessionOutcomeCurrentWorkspaceMatches(source, producer) ||
      snapshot.manifest.some((file) => !selected.has(file.path)) ||
      new Set(snapshot.manifest.map((file) => file.path)).size !== snapshot.manifest.length ||
      logicalDigest(
        snapshot.manifest.map((file) => ({
          target_path: file.path,
          sha256: file.sha256,
          size_bytes: file.size_bytes
        }))
      ) !== snapshot.snapshot_digest
    ) {
      return false
    }
    expected = {
      schema_version: 1,
      kind: 'accepted_folder_snapshot',
      snapshot_digest: snapshot.snapshot_digest,
      artifact_sha256: artifact.sha256,
      source_job_id: receipt.jobId,
      source_attempt: receipt.attempt
    }
  }
  return reviews.every((review) =>
    isDeepStrictEqual(review.folderArtifact!.reviewedSnapshot, expected)
  )
}
