import { createHash } from 'node:crypto'
import { z } from 'zod'
import type {
  ConsoleFolderReviewedSnapshot,
  ConsoleLocalExecutionPort
} from '../console-workflows/console-local-execution-contract'
import { normalizeConsoleJobBinding } from '../runtime/orchestration/console-job-binding'
import { consoleWorkflowJson, jobId } from '../../shared/console-workflow-schemas'
import { failure, requestConsoleWorkflow } from './console-workflow-transport'

const artifactReceipt = z.object({
  job_id: jobId,
  attempt: z.number().int().positive(),
  file_id: z.string().regex(/^tfl_[a-z0-9]{1,64}$/),
  principal: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  rel: z.string().min(1).max(4096),
  size_bytes: z.number().int().positive().max(65_536),
  folder_snapshot: z
    .object({
      snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/),
      manifest: z
        .array(
          z
            .object({
              path: z.string().min(1).max(1024),
              mode: z.number().int().min(0).max(0o777),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              size_bytes: z.number().int().min(0).max(65_536)
            })
            .strict()
        )
        .max(288)
    })
    .strict()
    .optional(),
  reviewed_snapshot: z
    .discriminatedUnion('kind', [
      z
        .object({
          schema_version: z.literal(1),
          kind: z.literal('current_task_files'),
          snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/)
        })
        .strict(),
      z
        .object({
          schema_version: z.literal(1),
          kind: z.literal('accepted_folder_snapshot'),
          snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/),
          artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/),
          source_job_id: jobId,
          source_attempt: z.number().int().positive()
        })
        .strict()
    ])
    .optional()
})

/** The existing server artifact outbox owns task-file identity and exact upload replay. */
export const publishConsoleFolderArtifact: NonNullable<
  ConsoleLocalExecutionPort['publishFolderArtifact']
> = async (input) => {
  let binding
  let bytes: Buffer
  try {
    binding = normalizeConsoleJobBinding(input.binding)
    bytes = Buffer.from(input.contentBase64, 'base64')
    const report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (
      !binding.claim?.host.startsWith('local:') ||
      !binding.inputDigest ||
      !/^[a-f0-9]{64}$/.test(input.principal) ||
      binding.jobId !== input.job.id ||
      binding.taskId !== input.job.taskId ||
      binding.workflowId !== input.job.workflowId ||
      (input.job.workspace?.kind !== 'folder' &&
        (!input.job.repo ||
          !input.job.artifactResult ||
          input.job.acceptanceCommands.length > 0)) ||
      !/^[a-f0-9]{64}$/.test(input.job.digest) ||
      bytes.toString('base64') !== input.contentBase64 ||
      bytes.length > 65_536 ||
      !report ||
      typeof report !== 'object' ||
      Array.isArray(report) ||
      !Object.keys(report).length ||
      !consoleWorkflowJson.safeParse(report).success
    ) {
      throw new Error('invalid_artifact')
    }
  } catch {
    return failure(
      'invalid_request',
      'The artifact result requires its claimed execution and exact bounded report.'
    )
  }
  const claim = binding.claim!
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const path = input.job.artifactResult?.path ?? 'work-result.json'
  const rel = `uploads/${binding.jobId}-${binding.attempt}-${path}`
  const response = await requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${binding.jobId}/artifact`,
    'POST',
    artifactReceipt.refine(
      (receipt) =>
        receipt.job_id === binding.jobId &&
        receipt.attempt === binding.attempt &&
        receipt.sha256 === sha256 &&
        receipt.size_bytes === bytes.length &&
        receipt.rel === rel
    ),
    {
      host: claim.host,
      attempt: binding.attempt,
      claimed_at: claim.claimedAt,
      path,
      plan_revision: input.job.digest,
      content_b64: input.contentBase64,
      runner_instance: claim.runnerInstance,
      lease_generation: binding.leaseGeneration,
      claim_request_id: claim.claimRequestId,
      attempt_intent_id: claim.attemptIntentId,
      dispatch_key: claim.dispatchKey
    },
    60_000,
    true,
    input.principal
  )
  return response.ok
    ? {
        ok: true,
        data: {
          fileId: response.data.file_id,
          sha256: response.data.sha256,
          ...(response.data.folder_snapshot
            ? {
                folderSnapshot: {
                  snapshotDigest: response.data.folder_snapshot.snapshot_digest,
                  manifest: response.data.folder_snapshot.manifest.map((item) => ({
                    path: item.path,
                    mode: item.mode,
                    sha256: item.sha256,
                    sizeBytes: item.size_bytes
                  }))
                }
              }
            : {}),
          ...(response.data.reviewed_snapshot
            ? {
                reviewedSnapshot: {
                  schemaVersion: 1,
                  kind: response.data.reviewed_snapshot.kind,
                  snapshotDigest: response.data.reviewed_snapshot.snapshot_digest,
                  ...(response.data.reviewed_snapshot.kind === 'accepted_folder_snapshot'
                    ? {
                        artifactSha256: response.data.reviewed_snapshot.artifact_sha256,
                        sourceJobId: response.data.reviewed_snapshot.source_job_id,
                        sourceAttempt: response.data.reviewed_snapshot.source_attempt
                      }
                    : {})
                } as ConsoleFolderReviewedSnapshot
              }
            : {})
        }
      }
    : response
}
