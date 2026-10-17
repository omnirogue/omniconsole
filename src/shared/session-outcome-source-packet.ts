import { z } from 'zod'

const text = z.string().min(1).max(4096)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const sessionOutcomeSourceBindingSchema = z
  .object({
    sourcePaneKey: text,
    sourceWorktreeId: text,
    sourceHandle: text,
    processIncarnation: text
  })
  .strict()

export const sessionOutcomeSourcePacketSchema = sessionOutcomeSourceBindingSchema
  .extend({
    sourceVersion: digest,
    capturedAt: z.number().finite().nonnegative(),
    summaryKind: z.enum(['agent-response', 'terminal-output', 'unavailable']),
    summary: z.string().max(100_000),
    workspaceChangesUnavailable: z.boolean(),
    files: z
      .array(
        z
          .object({
            sourcePath: text,
            path: text,
            name: text,
            sha256: digest,
            size: z
              .number()
              .int()
              .nonnegative()
              .max(10 * 1024 * 1024)
          })
          .strict()
      )
      .max(32),
    missingFiles: z.array(text).max(32)
  })
  .strict()

export type SessionOutcomeSourceBinding = z.infer<typeof sessionOutcomeSourceBindingSchema>
export type SessionOutcomeSourcePacket = z.infer<typeof sessionOutcomeSourcePacketSchema>
