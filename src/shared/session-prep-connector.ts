import { z } from 'zod'

export const SESSION_PREP_CONNECTOR_MAX_REQUEST_BYTES = 24_000
export const sessionPrepConnectorTextSchema = z
  .string()
  .min(1)
  .max(SESSION_PREP_CONNECTOR_MAX_REQUEST_BYTES)
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= SESSION_PREP_CONNECTOR_MAX_REQUEST_BYTES,
    'Connector requests must be at most 24,000 UTF-8 bytes.'
  )

export const sessionPrepConnectorLaunchSchema = z
  .object({
    managedToolsFile: z.string().min(1).max(4096),
    nativeOperationId: z.string().regex(/^\d{13}-[0-9a-f]{32}$/),
    controllerRuntimeId: z.string().uuid().optional(),
    resultsFolder: z.string().min(1).max(4096),
    title: z.string().min(1).max(160),
    provider: z.enum(['claude', 'codex', 'gemini']).optional(),
    model: z.string().min(1).max(80).optional(),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
  })
  .strict()

export const sessionPrepConnectorSchema = z
  .object({
    // JSON escapes and base64 can expand the 24,000-character request eightfold.
    payload: z.string().min(1).max(200_000),
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    statusOnly: z.boolean().optional(),
    launch: sessionPrepConnectorLaunchSchema
  })
  .strict()

export type SessionPrepConnectorLaunch = z.infer<typeof sessionPrepConnectorLaunchSchema>
export type SessionPrepConnector = z.infer<typeof sessionPrepConnectorSchema>
