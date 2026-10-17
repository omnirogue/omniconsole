import { z } from 'zod'

const argument = z
  .string()
  .max(4096)
  .regex(/^[^\0\r\n]*$/)

// Preserve frozen argv values; only the server canonicalizes executable names.
export const consoleWorkflowAcceptanceCommand = z
  .object({
    program: argument.refine((value) => value.trim().length > 0),
    args: z.array(argument).max(128),
    timeout_ms: z.number().int().min(1).max(3_600_000)
  })
  .strict()

export const consoleWorkflowAcceptanceCommands = z
  .array(consoleWorkflowAcceptanceCommand)
  .max(32)
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 65_536)

export type ConsoleWorkflowAcceptanceCommand = z.infer<typeof consoleWorkflowAcceptanceCommand>
