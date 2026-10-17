import { z } from 'zod'

/**
 * `POST /api/app-health` — the IDE telling the console that a feature worked, failed
 * or crashed, so that "memory did not load" is visible to Sal/Uma rather than
 * silently wrong on one employee's machine. Never carries transcript text, dump
 * bytes or paths: a feature name, a status, a short code and a bounded message.
 */
export const APP_HEALTH_APP = 'omni-ide'
export const APP_HEALTH_MESSAGE_MAX_BYTES = 2048

export const APP_HEALTH_STATUSES = ['ok', 'error', 'crash'] as const
export type AppHealthStatus = (typeof APP_HEALTH_STATUSES)[number]

export const APP_HEALTH_FEATURES = [
  'startup',
  'mcp_wiring',
  'transcript_upload',
  'team_memory',
  'crash'
] as const
export type AppHealthFeature = (typeof APP_HEALTH_FEATURES)[number]

export const appHealthReportBody = z
  .object({
    app: z.literal(APP_HEALTH_APP),
    version: z.string().min(1).max(64),
    platform: z.string().min(1).max(32).optional(),
    feature: z.enum(APP_HEALTH_FEATURES),
    status: z.enum(APP_HEALTH_STATUSES),
    code: z
      .string()
      .regex(/^[a-z0-9_.-]{1,64}$/)
      .optional(),
    message: z.string().max(APP_HEALTH_MESSAGE_MAX_BYTES).optional(),
    /** ISO-8601; when the event happened, which is earlier than when it is sent for a crash. */
    at: z.string().min(1).optional()
  })
  .strict()
export type AppHealthReportBody = z.infer<typeof appHealthReportBody>

/** What a caller supplies; app/version/platform are stamped by the reporter. */
export type AppHealthReportInput = {
  feature: AppHealthFeature
  status: AppHealthStatus
  code?: string
  message?: string
  at?: string
}

/** The console acknowledges with anything JSON; only "it landed" matters here. */
export const appHealthReportAnswer = z.object({}).passthrough()

/** Bounded, single-line, never a path or a secret-shaped string on our side. */
export function clipAppHealthMessage(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  const encoder = new TextEncoder()
  if (encoder.encode(flat).byteLength <= APP_HEALTH_MESSAGE_MAX_BYTES) {
    return flat
  }
  let clipped = flat.slice(0, APP_HEALTH_MESSAGE_MAX_BYTES)
  while (encoder.encode(clipped).byteLength > APP_HEALTH_MESSAGE_MAX_BYTES) {
    clipped = clipped.slice(0, -1)
  }
  return clipped
}
