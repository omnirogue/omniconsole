import { z } from 'zod'
import { BOARD_TASK_ID_PATTERN } from './board-task-id'
import type { ConsoleConversationFleetSourceFile } from './console-conversation-fleet-types'

export function containsSourceControlCharacter(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  )
}

export const consoleConversationSourcePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('~') &&
      !value.includes('\\') &&
      !containsSourceControlCharacter(value) &&
      !/^[A-Za-z]:/.test(value) &&
      value
        .split('/')
        .every(
          (part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'
        )
  )

export const consoleConversationSourceFile: z.ZodType<ConsoleConversationFleetSourceFile> = z
  .object({
    kind: z.literal('task_file'),
    task_id: z.string().regex(BOARD_TASK_ID_PATTERN),
    file: z
      .object({
        rel: consoleConversationSourcePath,
        name: z
          .string()
          .min(1)
          .max(255)
          .refine((value) => !/[\\/]/.test(value) && !containsSourceControlCharacter(value)),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        size_bytes: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 1024 * 1024)
      })
      .strict(),
    target_path: consoleConversationSourcePath.optional(),
    executable: z.boolean().optional()
  })
  .strict()
  .refine((value) => value.executable === undefined || value.target_path !== undefined)
