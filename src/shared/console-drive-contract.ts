import { z } from 'zod'
import { taskId } from './console-workflow-schemas'
import type { ConsoleWorkflowResult } from './console-workflow-types'

const text = z.string().max(2048)
const driveLink = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'drive.google.com'
  })

export const consoleDriveDestination = z.object({
  scope: text,
  scope_key: text,
  display: text,
  target: text
})

export const consoleDriveIntakeFile = z.object({
  file_id: text,
  name: text,
  size_bytes: z.number().int().nonnegative(),
  link: driveLink.or(z.literal('')),
  sender_id: text,
  sender_email: text,
  disposition: text,
  first_seen_at: text,
  task_file_id: text.optional(),
  delivery_id: text.optional()
})

export const consoleDriveIntake = z.object({
  id: z.string().regex(/^drin_[A-Za-z0-9_-]{1,128}$/),
  task_id: taskId,
  pattern: text,
  expected_from: text,
  expected_from_email: text,
  expected_count: z.number().int().positive().nullable(),
  share_role: text,
  status: text,
  arrivals: z.number().int().nonnegative(),
  created_by: text,
  created_at: text,
  folder_link: driveLink,
  destination: consoleDriveDestination.optional(),
  files: z.array(consoleDriveIntakeFile)
})

export const consoleCardDrive = z
  .object({
    task_id: taskId,
    supports_project_intake_precondition: z.boolean().optional(),
    destination: consoleDriveDestination,
    declared: z.boolean(),
    folder: z
      .object({
        registry_id: text,
        folder_id: text,
        link: driveLink,
        status: text
      })
      .nullable(),
    intakes: z.array(consoleDriveIntake).optional()
  })
  .refine(
    (value) =>
      value.declared === (value.folder !== null) &&
      (value.intakes ?? []).every((intake) => intake.task_id === value.task_id)
  )

export const consoleDriveIntakes = z.object({
  task_id: taskId,
  intakes: z.array(consoleDriveIntake)
})

export const consoleDriveFileRequest = z
  .object({
    taskId,
    expectedScopeKey: z.string().min(1).max(200),
    expected_from: z.string().regex(/^emp_[A-Za-z0-9_-]{1,120}$/),
    pattern: z.string().min(1).max(256),
    expected_count: z.number().int().min(1).max(10_000).optional()
  })
  .strict()

export type ConsoleCardDrive = z.infer<typeof consoleCardDrive>
export type ConsoleDriveIntake = z.infer<typeof consoleDriveIntake>
export type ConsoleDriveFileRequest = z.infer<typeof consoleDriveFileRequest>
export type ConsoleDriveApi = {
  get: (args: { taskId: string }) => Promise<ConsoleWorkflowResult<ConsoleCardDrive>>
  intakes: (args: {
    taskId: string
  }) => Promise<ConsoleWorkflowResult<z.infer<typeof consoleDriveIntakes>>>
  declare: (args: { taskId: string }) => Promise<ConsoleWorkflowResult<ConsoleCardDrive>>
  requestFiles: (
    args: ConsoleDriveFileRequest
  ) => Promise<ConsoleWorkflowResult<ConsoleDriveIntake>>
}
