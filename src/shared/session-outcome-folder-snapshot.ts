import { z } from 'zod'
import { consoleConversationSourcePath } from './console-conversation-source-files'
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const jobId = z.string().regex(/^job_[a-z0-9]{8,40}$/)
export const sessionOutcomeFolderSnapshot = z
  .object({
    snapshot_digest: digest,
    manifest: z
      .array(
        z
          .object({
            path: consoleConversationSourcePath,
            mode: z.number().int().min(0).max(0o777),
            sha256: digest,
            size_bytes: z.number().int().nonnegative().max(65536)
          })
          .strict()
      )
      .max(288)
  })
  .strict()
export const sessionOutcomeReviewedSnapshot = z.discriminatedUnion('kind', [
  z
    .object({
      schema_version: z.literal(1),
      kind: z.literal('current_task_files'),
      snapshot_digest: digest
    })
    .strict(),
  z
    .object({
      schema_version: z.literal(1),
      kind: z.literal('accepted_folder_snapshot'),
      snapshot_digest: digest,
      artifact_sha256: digest,
      source_job_id: jobId,
      source_attempt: z.number().int().positive()
    })
    .strict()
])
export const sessionOutcomeFolderArtifact = z
  .object({
    resultEventId: z.number().int().positive(),
    fileId: z.string().regex(/^tfl_[a-z0-9]{1,64}$/),
    sha256: digest,
    folderSnapshot: sessionOutcomeFolderSnapshot.optional(),
    reviewedSnapshot: sessionOutcomeReviewedSnapshot.optional()
  })
  .strict()
  .refine(
    (value) => Boolean(value.folderSnapshot) !== Boolean(value.reviewedSnapshot),
    'A folder result must name exactly its snapshot or reviewed snapshot.'
  )
export type SessionOutcomeFolderArtifact = z.infer<typeof sessionOutcomeFolderArtifact>
