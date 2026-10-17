import { z } from 'zod'
import { jobId } from './console-workflow-schemas'
import { handoffDigest, handoffId } from './console-handoff-contract'
import { containsSourceControlCharacter } from './console-conversation-source-files'

export const consoleJobArtifactReceipt = z
  .object({
    job_id: jobId,
    attempt: z.number().int().positive(),
    file_id: z.string().regex(/^tfl_[a-z0-9]{1,64}$/),
    principal: z.string().min(1),
    sha256: handoffDigest,
    rel: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value.includes('\\') &&
          !containsSourceControlCharacter(value) &&
          value.split('/').every((part) => !['', '.', '..', '.git'].includes(part.toLowerCase()))
      ),
    size_bytes: z
      .number()
      .int()
      .positive()
      .max(48 * 1024 * 1024)
  })
  .strict()

export const consolePersonHandoffDelivery = z.object({
  status: z.enum(['pending', 'delivered']),
  job_id: jobId.optional(),
  request_digest: handoffDigest,
  input_digest: handoffDigest.optional(),
  recipient_employee_id: z.string().min(1),
  author_employee_id: z.string().optional(),
  thread_id: handoffId.optional(),
  delivery_id: z.string().nullable().optional()
})

export type ConsoleJobArtifactReceipt = z.infer<typeof consoleJobArtifactReceipt>
export type ConsolePersonHandoffDelivery = z.infer<typeof consolePersonHandoffDelivery>
export const consolePersonHandoffStatus = z.object({
  state: z.enum(['blocked', 'waiting']),
  code: z.string(),
  message: z.string(),
  checked_at: z.string()
})
export type ConsolePersonHandoffStatus = z.infer<typeof consolePersonHandoffStatus>
export type ConsoleJobResultsRequest = { jobId: string; attempt: number }
export type ConsoleJobFolderResult = {
  job_id: string
  attempt: number
  receipt: ConsoleJobArtifactReceipt
  response: string
  changed_files: string[]
  files: { path: string; mode: number; sha256: string; size_bytes: number; content_b64: string }[]
}
export type ConsoleJobResults = ConsoleJobFolderResult
