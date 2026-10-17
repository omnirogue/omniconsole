import { z } from 'zod'
import type { ProviderRateLimits } from './rate-limit-types'

const configRoot = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes('\0') &&
      (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')),
    'An absolute selected account configuration root is required.'
  )
const token = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => value.trim().length > 0)

export const selectedAccountUsageRequestSchema = z.discriminatedUnion('provider', [
  z.object({ version: z.literal(1), provider: z.literal('codex'), configRoot }).strict(),
  z.object({ version: z.literal(1), provider: z.literal('grok'), configRoot }).strict(),
  z
    .object({
      version: z.literal(1),
      provider: z.literal('claude'),
      configRoot,
      token: token.optional()
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      provider: z.literal('kimi'),
      token,
      baseUrl: z.string().min(1).max(2048)
    })
    .strict()
])

export type SelectedAccountUsageRequest = z.infer<typeof selectedAccountUsageRequestSchema>

const timestamp = z.number().finite().min(0).max(32_503_680_000_000)
const source = z.enum(['oauth', 'cli', 'web', 'live-session'])
const failureKind = z.enum([
  'missing-credentials',
  'stale-token',
  'refreshable-credentials-without-token',
  'delegated-refresh-required',
  'deferred-by-live-session',
  'keychain-unavailable',
  'missing-scope',
  'network',
  'server',
  'parse',
  'rate-limited',
  'cli-unavailable',
  'usage-unavailable',
  'unknown'
])
const safeError = z.enum([
  'missing-credentials',
  'stale-token',
  'missing-scope',
  'network',
  'server',
  'parse',
  'rate-limited',
  'cli-unavailable',
  'usage-unavailable',
  'unknown'
])
const windowSchema = z
  .object({
    usedPercent: z.number().finite().min(0).max(100),
    windowMinutes: z.number().finite().positive().max(525_600),
    resetsAt: timestamp.nullable(),
    resetDescription: z.null()
  })
  .strict()

export const fleetAccountUsageSchema = z
  .object({
    provider: z.enum(['claude', 'codex', 'gemini', 'kimi', 'grok']),
    status: z.enum(['idle', 'fetching', 'ok', 'error', 'unavailable']),
    updatedAt: timestamp,
    error: safeError.nullable(),
    session: windowSchema.nullable(),
    weekly: windowSchema.nullable(),
    fableWeekly: windowSchema.nullable().optional(),
    monthly: windowSchema.nullable().optional(),
    buckets: z
      .array(
        windowSchema
          .extend({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) })
          .strict()
      )
      .max(64)
      .optional(),
    usageMetadata: z
      .object({
        source: source.optional(),
        failureKind: failureKind.optional(),
        retryAtMs: timestamp.optional()
      })
      .strict()
      .optional()
  })
  .strict()
  .refine((value) => value.status !== 'ok' || (value.error === null && value.updatedAt > 0))

export const fleetAccountUsageReceiptSchema = z
  .object({
    version: z.literal(1),
    selected_account_ref: z.uuidv4(),
    account_generation: z.uuidv4(),
    usage: fleetAccountUsageSchema.nullable()
  })
  .strict()

export type FleetAccountUsageReceipt = z.infer<typeof fleetAccountUsageReceiptSchema>

function sanitizeWindow(window: ProviderRateLimits['session']) {
  return window === null
    ? null
    : {
        usedPercent: window.usedPercent,
        windowMinutes: window.windowMinutes,
        resetsAt: window.resetsAt,
        resetDescription: null
      }
}

/** Provider responses may contain account identities and raw service errors. */
export function sanitizeFleetAccountUsage(
  raw: ProviderRateLimits,
  provider: SelectedAccountUsageRequest['provider']
): ProviderRateLimits {
  const unavailable: ProviderRateLimits = {
    provider,
    status: 'unavailable',
    updatedAt: Date.now(),
    error: 'usage-unavailable',
    session: null,
    weekly: null,
    usageMetadata: { failureKind: 'usage-unavailable' }
  }
  if (raw.provider !== provider || (raw.status === 'ok' && raw.error !== null)) {
    return unavailable
  }
  const metadata = raw.usageMetadata
  const usageMetadata = metadata
    ? {
        ...(source.safeParse(metadata.source).success ? { source: metadata.source } : {}),
        ...(failureKind.safeParse(metadata.failureKind).success
          ? { failureKind: metadata.failureKind }
          : {}),
        ...(timestamp.safeParse(metadata.retryAtMs).success
          ? { retryAtMs: metadata.retryAtMs }
          : {})
      }
    : undefined
  if (raw.status !== 'ok') {
    const error = safeError.safeParse(metadata?.failureKind)
    return {
      ...unavailable,
      error: error.success ? error.data : 'usage-unavailable',
      usageMetadata
    }
  }
  const parsed = fleetAccountUsageSchema.safeParse({
    provider,
    status: 'ok',
    updatedAt: raw.updatedAt,
    error: null,
    session: sanitizeWindow(raw.session),
    weekly: sanitizeWindow(raw.weekly),
    ...(raw.monthly === undefined ? {} : { monthly: sanitizeWindow(raw.monthly) }),
    ...(raw.fableWeekly === undefined ? {} : { fableWeekly: sanitizeWindow(raw.fableWeekly) }),
    ...(raw.buckets === undefined
      ? {}
      : {
          buckets: raw.buckets.map((bucket) => ({ ...sanitizeWindow(bucket), name: bucket.name }))
        }),
    ...(usageMetadata ? { usageMetadata } : {})
  })
  return parsed.success ? parsed.data : unavailable
}
