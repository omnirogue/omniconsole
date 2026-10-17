import { z } from 'zod'
import { HANDOFF_FILE_MAX_BYTES, handoffDigest } from './console-handoff-contract'
import { consoleConversationSourcePath } from './console-conversation-source-files'
import { SESSION_FOLLOW_UP_MAX_MANIFESTS } from './session-follow-up-rule-fields'

export const FLEET_SOURCE_MAX_FILES = 30
export const FLEET_SOURCE_MAX_DELETIONS = 256
export const FLEET_SOURCE_MAX_BYTES = 32 * 1024 * 1024
export const FLEET_SOURCE_CHUNK_BYTES = 256 * 1024

function deliverablesSchema(path: z.ZodType<string>) {
  return z.discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('files'), paths: z.array(path).max(FLEET_SOURCE_MAX_FILES) })
      .strict(),
    z.object({ kind: z.literal('manifest'), manifestPath: path }).strict(),
    z
      .object({
        kind: z.literal('manifests'),
        manifestPaths: z.array(path).min(1).max(SESSION_FOLLOW_UP_MAX_MANIFESTS)
      })
      .strict()
  ])
}

export const fleetSourceDeliverables = deliverablesSchema(z.string().min(1).max(4096))
export const capturedFleetSourceDeliverables = deliverablesSchema(consoleConversationSourcePath)

export const captureFleetSourceRequest = z
  .object({
    worktree: z.string().min(1).max(4096),
    paths: z.array(z.string().min(1).max(4096)).max(FLEET_SOURCE_MAX_FILES),
    includeDirtyTracked: z.boolean(),
    includeUntracked: z.boolean().optional(),
    expectedConnectionId: z.string().min(1).nullable().optional(),
    deliverables: fleetSourceDeliverables.optional()
  })
  .strict()

export const capturedFleetSourceFile = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(HANDOFF_FILE_MAX_BYTES),
    sha256: handoffDigest,
    targetPath: consoleConversationSourcePath,
    executable: z.boolean()
  })
  .strict()

export const captureFleetSourceResult = z
  .object({
    snapshotId: z.string().uuid(),
    baseCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    remoteUrl: z.string().max(4096).optional(),
    branch: z.string().max(4096).optional(),
    files: z.array(capturedFleetSourceFile).max(FLEET_SOURCE_MAX_FILES),
    deletions: z.array(consoleConversationSourcePath).max(FLEET_SOURCE_MAX_DELETIONS),
    warnings: z.array(z.string()),
    source: z.object({ connectionId: z.string().nullable() }).strict(),
    deliverables: capturedFleetSourceDeliverables.optional(),
    deliverablePaths: z.array(consoleConversationSourcePath).max(FLEET_SOURCE_MAX_FILES).optional()
  })
  .strict()
  .superRefine((snapshot, context) => {
    if ((snapshot.deliverables === undefined) !== (snapshot.deliverablePaths === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A handoff snapshot needs both its deliverable rule and complete file set.'
      })
      return
    }
    const paths = new Set(snapshot.deliverablePaths ?? [])
    const capturedPaths = new Set(snapshot.files.map((file) => file.targetPath))
    if (
      paths.size !== (snapshot.deliverablePaths?.length ?? 0) ||
      [...paths].some((path) => !capturedPaths.has(path))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Every declared handoff file must exist in the captured source snapshot.'
      })
    }
    const rule = snapshot.deliverables
    const declared =
      rule?.kind === 'files'
        ? rule.paths
        : rule?.kind === 'manifest'
          ? [rule.manifestPath]
          : (rule?.manifestPaths ?? [])
    if (declared.some((path) => !paths.has(path))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The handoff deliverable rule references an uncaptured file.'
      })
    }
    if (rule?.kind === 'files' && new Set(declared).size !== paths.size) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only explicitly requested handoff files belong in a direct-file deliverable set.'
      })
    }
  })

export const readFleetSourceChunkRequest = z
  .object({
    snapshotId: z.string().uuid(),
    fileId: z.string().uuid(),
    offset: z.number().int().nonnegative().max(HANDOFF_FILE_MAX_BYTES),
    limit: z.number().int().positive().max(FLEET_SOURCE_CHUNK_BYTES).optional()
  })
  .strict()

export const readFleetSourceChunkResult = z
  .object({
    contentBase64: z.string().max(Math.ceil(FLEET_SOURCE_CHUNK_BYTES / 3) * 4),
    nextOffset: z.number().int().nonnegative().max(HANDOFF_FILE_MAX_BYTES),
    complete: z.boolean()
  })
  .strict()

export const releaseFleetSourceRequest = z.object({ snapshotId: z.string().uuid() }).strict()

export type CaptureFleetSourceRequest = z.infer<typeof captureFleetSourceRequest>
export type CaptureFleetSourceResult = z.infer<typeof captureFleetSourceResult>
export type CapturedFleetSourceFile = z.infer<typeof capturedFleetSourceFile>
export type ReadFleetSourceChunkRequest = z.infer<typeof readFleetSourceChunkRequest>
export type ReadFleetSourceChunkResult = z.infer<typeof readFleetSourceChunkResult>
