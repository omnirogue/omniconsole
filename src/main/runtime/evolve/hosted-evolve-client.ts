import type { z } from 'zod'
import { getSharedOmniRogueAccountLease } from '../../omnirogue-account/omnirogue-account-lease'
import { readFetchResponseJsonWithinLimit } from '../../../shared/fetch-response-body'
import {
  evolveSpecPath,
  type EvolveExecutionTier,
  type EvolveLedgerStatus,
  type EvolvePromotionSummary,
  type EvolveStartRequest,
  type EvolveWinnerArtifact,
  type HostedEvolveExecutionTier
} from '../../../shared/evolve-workflow'
import {
  estimateHostedEvolveCredits,
  type EvolveDraft,
  type HostedEvolveQuote
} from '../../../shared/evolve-workflow-draft'
import {
  isPlainRecord,
  pollResponseSchema,
  promotionSummarySchema,
  quoteResponseSchema,
  startResponseSchema
} from './hosted-evolve-schemas'
import {
  HostedEvolveOutcomeUnknownError,
  hostedEvolveTransportFailure
} from './hosted-evolve-outcome'
import {
  capHostedEvolveSpend,
  readHostedEvolveSpec,
  type HostedEvolveSpecDeps
} from './hosted-evolve-spec'

export const DEFAULT_OMNISI_CLOUD_URL = 'https://app.omnisi.ai'
const HOSTED_EVOLVE_API_PREFIX = '/api/evolve'
const MAX_RESPONSE_BYTES = 1_048_576
const REQUEST_TIMEOUT_MS = 20_000
const CLOUD_RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

const ALLOWED_ROUTE_PATTERNS = [
  /^\/api\/evolve\/quote$/,
  /^\/api\/evolve\/runs$/,
  /^\/api\/evolve\/runs\/[A-Za-z0-9._:-]{1,128}$/,
  /^\/api\/evolve\/runs\/[A-Za-z0-9._:-]{1,128}\/events$/,
  /^\/api\/evolve\/runs\/[A-Za-z0-9._:-]{1,128}\/promote$/,
  /^\/api\/evolve\/runs\/[A-Za-z0-9._:-]{1,128}\/rollback$/
]

export type HostedEvolveStartResult = z.infer<typeof startResponseSchema> & {
  target: string
  iterations: number
  usdCap: number
}
export type HostedEvolvePollResult = {
  cloudRunId: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped'
  ledger?: EvolveLedgerStatus
  promotionSummary?: EvolvePromotionSummary
  winnerArtifact?: EvolveWinnerArtifact
  error?: string
}

export type HostedEvolveClientDeps = HostedEvolveSpecDeps & {
  baseUrl?: string
  fetchImpl?: typeof fetch
  leaseToken?: () => Promise<string | null> | string | null
}

function resolveBaseOrigin(override?: string): string {
  const raw = (override ?? process.env.OMNISI_CLOUD_URL ?? DEFAULT_OMNISI_CLOUD_URL).trim()
  const parsed = new URL(raw)
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new Error(`Omnisi cloud endpoint must use https: ${parsed.origin}`)
  }
  return parsed.origin
}

function assertAllowedRoute(pathname: string): void {
  if (!ALLOWED_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname))) {
    throw new Error(`Disallowed hosted Evolve route: ${pathname}`)
  }
}

export function assertValidCloudRunId(cloudRunId: string): string {
  const trimmed = cloudRunId.trim()
  if (!CLOUD_RUN_ID_PATTERN.test(trimmed)) {
    throw new Error(`Invalid hosted Evolve cloudRunId: ${cloudRunId}`)
  }
  return trimmed
}

/**
 * Resolves the active OmniRogue `or_obp_` token without mutating or clearing the account lease.
 */
export async function resolveHostedEvolveBearerToken(
  customLease?: () => Promise<string | null> | string | null
): Promise<string | null> {
  const token = customLease
    ? await customLease()
    : await getSharedOmniRogueAccountLease().leaseToken()
  return token && token.trim().length > 0 ? token.trim() : null
}

/** The URL, bearer and fetch for one allowed hosted route; refuses before any network call. */
export async function hostedEvolveConnection(
  pathname: string,
  deps?: HostedEvolveClientDeps
): Promise<{ url: string; token: string; fetchFn: typeof fetch }> {
  assertAllowedRoute(pathname)
  const token = await resolveHostedEvolveBearerToken(deps?.leaseToken)
  if (!token) {
    throw new Error(
      'Connect your OmniRogue account in Settings before running Hosted Super Intelligence.'
    )
  }
  const url = `${resolveBaseOrigin(deps?.baseUrl)}${pathname}`
  return { url, token, fetchFn: deps?.fetchImpl ?? fetch }
}

/** First-party 401 rule: NEVER clear or unlink the OmniRogue session on a 401 from the cloud. */
export function hostedEvolveAuthRejection(status: number): Error | undefined {
  return status === 401 || status === 403
    ? new Error(
        `Hosted Super Intelligence rejected token (${status}); existing OmniRogue session preserved.`
      )
    : undefined
}

function errorDetail(body: unknown): string | undefined {
  return isPlainRecord(body) && typeof body.error === 'string' && body.error.trim()
    ? body.error.trim()
    : undefined
}

async function requestHostedEvolveJson<T>(
  pathname: string,
  init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
  schema: z.ZodType<T>,
  deps?: HostedEvolveClientDeps
): Promise<T> {
  const { url, token, fetchFn } = await hostedEvolveConnection(pathname, deps)
  let response: Response
  try {
    response = await fetchFn(url, {
      method: init.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    throw hostedEvolveTransportFailure(pathname, error)
  }

  const rejected = hostedEvolveAuthRejection(response.status)
  if (rejected) {
    throw rejected
  }

  let body: unknown
  let readFailure: string | undefined
  try {
    body = await readFetchResponseJsonWithinLimit<unknown>(response, MAX_RESPONSE_BYTES)
  } catch (error) {
    readFailure = error instanceof Error ? error.message : String(error)
  }
  if (!response.ok) {
    const message = `Hosted Evolve request failed (${pathname}): ${errorDetail(body) ?? `HTTP ${response.status}`}`
    throw response.status >= 500 ? new HostedEvolveOutcomeUnknownError(message) : new Error(message)
  }
  if (readFailure !== undefined) {
    throw new HostedEvolveOutcomeUnknownError(
      `Hosted Evolve response error (${pathname}): ${readFailure}`
    )
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new HostedEvolveOutcomeUnknownError(
      `Hosted Evolve response error (${pathname}): ${parsed.error.message}`
    )
  }
  return parsed.data
}

export async function quoteHostedEvolveRun(
  draft: Pick<EvolveDraft, 'target' | 'iterations' | 'executionTier' | 'seedFrom' | 'usdCap'>,
  deps?: HostedEvolveClientDeps
): Promise<HostedEvolveQuote> {
  const localEstimate = estimateHostedEvolveCredits({
    executionTier: draft.executionTier,
    iterations: draft.iterations,
    target: draft.target
  })
  const token = await resolveHostedEvolveBearerToken(deps?.leaseToken)
  if (!token) {
    return localEstimate
  }
  try {
    return await requestHostedEvolveJson(
      `${HOSTED_EVOLVE_API_PREFIX}/quote`,
      {
        method: 'POST',
        body: {
          target: draft.target,
          executionTier: localEstimate.executionTier,
          iterations: localEstimate.iterations,
          seedFrom: draft.seedFrom.trim() || undefined,
          usdCap: draft.usdCap.trim() ? Number(draft.usdCap) : undefined
        }
      },
      quoteResponseSchema,
      deps
    )
  } catch {
    return localEstimate
  }
}

/** Submits a hosted run with omnisi-evolve-service's snake_case `CreateRunBody`. */
export async function startHostedEvolveRun(
  request: EvolveStartRequest,
  deps?: HostedEvolveClientDeps
): Promise<HostedEvolveStartResult> {
  const executionTier: HostedEvolveExecutionTier =
    request.executionTier === 'hosted_pro' ? 'hosted_pro' : 'hosted_super_intelligence'
  const fallbackQuote = estimateHostedEvolveCredits({
    executionTier: executionTier as EvolveExecutionTier,
    iterations: request.iterations,
    target: request.target
  })
  const generations = request.iterations ?? fallbackQuote.iterations
  const specPath = evolveSpecPath(request)
  const spec = await readHostedEvolveSpec(request, deps)
  // CreateRunBody denies unknown top-level fields; the free-form spec carries the summary.
  if (typeof spec.target_summary !== 'string') {
    spec.target_summary = request.target === 'spec' ? specPath : `${request.target} (${specPath})`
  }
  const holdCents = capHostedEvolveSpend(spec, request.usdCap)

  const started = await requestHostedEvolveJson(
    `${HOSTED_EVOLVE_API_PREFIX}/runs`,
    {
      method: 'POST',
      body: {
        spec,
        generations,
        execution_tier: executionTier,
        seed_from_run_id: request.seedFromRunId,
        // Only when set; every service that accepts execution_tier accepts usd_cap (same release).
        ...(request.usdCap ? { usd_cap: request.usdCap } : {})
      }
    },
    startResponseSchema,
    deps
  )
  return {
    ...started,
    target: started.target ?? request.target,
    executionTier: started.executionTier ?? executionTier,
    estimatedCredits:
      started.estimatedCredits ?? request.estimatedCredits ?? fallbackQuote.estimatedCredits,
    iterations: started.iterations ?? generations,
    usdCap: started.usdCap ?? (holdCents !== undefined ? holdCents / 100 : 0)
  }
}

export async function pollHostedEvolveRun(
  cloudRunId: string,
  deps?: HostedEvolveClientDeps
): Promise<HostedEvolvePollResult> {
  const safeId = assertValidCloudRunId(cloudRunId)
  const raw = await requestHostedEvolveJson(
    `${HOSTED_EVOLVE_API_PREFIX}/runs/${encodeURIComponent(safeId)}`,
    { method: 'GET' },
    pollResponseSchema,
    deps
  )
  return {
    cloudRunId: raw.cloudRunId ?? safeId,
    status: raw.status ?? raw.ledger?.status ?? 'running',
    ledger: raw.ledger,
    promotionSummary: raw.promotionSummary,
    winnerArtifact: raw.winnerArtifact,
    error: raw.error ?? undefined
  }
}

export async function promoteHostedEvolveRun(
  cloudRunId: string,
  deps?: HostedEvolveClientDeps
): Promise<EvolvePromotionSummary> {
  const safeId = encodeURIComponent(assertValidCloudRunId(cloudRunId))
  return requestHostedEvolveJson(
    `${HOSTED_EVOLVE_API_PREFIX}/runs/${safeId}/promote`,
    { method: 'POST', body: {} },
    promotionSummarySchema,
    deps
  )
}

export async function rollbackHostedEvolveRun(
  cloudRunId: string,
  deps?: HostedEvolveClientDeps
): Promise<EvolvePromotionSummary> {
  const safeId = encodeURIComponent(assertValidCloudRunId(cloudRunId))
  return requestHostedEvolveJson(
    `${HOSTED_EVOLVE_API_PREFIX}/runs/${safeId}/rollback`,
    { method: 'POST', body: {} },
    promotionSummarySchema,
    deps
  )
}
