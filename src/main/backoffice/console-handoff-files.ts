import { z } from 'zod'
import { createHash } from 'node:crypto'
import {
  exactHandoffFile,
  handoffFile,
  handoffId,
  handoffDigest,
  type ExactHandoffFile
} from '../../shared/console-handoff-contract'
import { taskId } from '../../shared/console-workflow-schemas'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { downloadVerifiedConsoleFile } from './console-file-download'
import { failure, validated, requestConsoleWorkflowUpload } from './console-workflow-transport'

export const uploadHandoffFile = (args: unknown) =>
  validated(
    args,
    z
      .object({
        taskId,
        file: exactHandoffFile,
        purpose: z.literal('task').optional(),
        expectedPrincipal: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
      })
      .strict()
      .refine((input) => input.purpose !== 'task' || input.expectedPrincipal !== undefined),
    async (input) => {
      const bytes = Buffer.from(input.file.contentBase64, 'base64')
      if (
        bytes.toString('base64') !== input.file.contentBase64 ||
        bytes.length !== input.file.size ||
        createHash('sha256').update(bytes).digest('hex') !== input.file.sha256
      ) {
        return failure('file_changed', 'The file bytes do not match the selected version.')
      }
      const result = await requestConsoleWorkflowUpload(
        `/api/gtd/hub/api/board/${input.taskId}/files/upload`,
        z.object({
          files: z.array(
            z.object({ rel: z.string(), sha256: handoffDigest, size_bytes: z.number() })
          )
        }),
        {
          files: [{ name: input.file.name, contentType: 'application/octet-stream', bytes }],
          instructions:
            input.purpose === 'task' ? 'Attached to the task.' : 'Attached for a handoff.'
        },
        120_000,
        input.expectedPrincipal
      )
      if (!result.ok) {
        return result
      }
      const saved = result.data.files.find(
        (file) => file.sha256 === input.file.sha256 && file.size_bytes === bytes.length
      )
      return saved
        ? { ok: true as const, data: { path: saved.rel, sha256: saved.sha256 } }
        : failure(
            'invalid_response',
            'The saved file version could not be verified. Refresh Files before sending.'
          )
    }
  )

export const downloadHandoffFile = (
  args: unknown,
  expectedPrincipal?: string
): Promise<ConsoleWorkflowResult<ExactHandoffFile>> =>
  validated(
    args,
    z.object({ threadId: handoffId, file: handoffFile }).strict(),
    ({ threadId, file }) =>
      downloadVerifiedConsoleFile(
        `/api/gtd/hub/api/handoffs/${threadId}/files/${file.id}`,
        file,
        expectedPrincipal
      )
  )
