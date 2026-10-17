import { z } from 'zod'
import { BOARD_TASK_ID_PATTERN } from './board-task-id'
import { consoleConversationSourcePath } from './console-conversation-source-files'
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const sessionOutcomeCurrentProducer = z
  .object({ provider: z.string().min(1), model: z.string().min(1) })
  .strict()
export const sessionOutcomeCurrentGit = z
  .object({
    head_sha: z.string().regex(/^[a-f0-9]{40}$/),
    deleted_paths: z.array(consoleConversationSourcePath).max(256)
  })
  .strict()
export const sessionOutcomeSourceWorkspace = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('folder'), path: z.string().min(1), host: z.literal('local') })
    .strict(),
  z
    .object({
      kind: z.literal('git'),
      path: z.string().min(1),
      host: z.literal('local'),
      repo: z.string().min(1),
      base_branch: z.string().min(1),
      base_sha: sessionOutcomeCurrentGit.shape.head_sha
    })
    .strict()
])
export const sessionOutcomeCurrentInputFile = z
  .object({
    rel: consoleConversationSourcePath,
    sha256: digest,
    size_bytes: z.number().int().nonnegative(),
    name: z.string().min(1).max(4096),
    target_path: consoleConversationSourcePath
  })
  .strict()
export const sessionOutcomeCurrentInput = z
  .object({
    stage_key: z.string().min(1).max(96),
    mode: z.enum(['base', 'review-source']),
    producer: sessionOutcomeCurrentProducer.optional(),
    git: sessionOutcomeCurrentGit.optional(),
    files: z.array(sessionOutcomeCurrentInputFile).max(32)
  })
  .strict()
  .refine((input) => input.files.length > 0 || Boolean(input.git?.deleted_paths.length), {
    message: 'A current snapshot requires files or captured Git deletions.'
  })
export type SessionOutcomeCurrentInput = z.infer<typeof sessionOutcomeCurrentInput>
export type SessionOutcomeCurrentInputFile = z.infer<typeof sessionOutcomeCurrentInputFile>
export type SessionOutcomeCurrentGit = z.infer<typeof sessionOutcomeCurrentGit>
export type SessionOutcomeCurrentSnapshot = {
  files: SessionOutcomeCurrentInputFile[]
  git?: SessionOutcomeCurrentGit
}
export const sessionOutcomeCurrentSource = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('current_task_files'),
    mode: z.enum(['base', 'review-source']),
    stage_key: z.string().min(1).max(96),
    root_task_id: z.string().regex(BOARD_TASK_ID_PATTERN),
    snapshot_digest: digest,
    producer: sessionOutcomeCurrentProducer,
    repair_producer: sessionOutcomeCurrentProducer.optional(),
    workspace: sessionOutcomeSourceWorkspace.optional(),
    git: sessionOutcomeCurrentGit.optional(),
    files: z
      .array(
        z
          .object({
            kind: z.literal('task_file'),
            task_id: z.string().regex(BOARD_TASK_ID_PATTERN),
            file: sessionOutcomeCurrentInputFile.omit({ target_path: true }),
            target_path: consoleConversationSourcePath
          })
          .strict()
      )
      .max(32)
  })
  .strict()
  .refine((source) => source.files.length > 0 || Boolean(source.git?.deleted_paths.length), {
    message: 'A current snapshot requires files or captured Git deletions.'
  })
