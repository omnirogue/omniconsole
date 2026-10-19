import { readFetchResponseJsonWithinLimit } from '../../../shared/fetch-response-body'
import {
  assertValidCloudRunId,
  DEFAULT_OMNISI_CLOUD_URL,
  hostedEvolveAuthRejection,
  resolveHostedEvolveBearerToken,
  type HostedEvolveClientDeps
} from './hosted-evolve-client'
import { isPlainRecord } from './hosted-evolve-schemas'

const MAX_RESPONSE_BYTES = 1_048_576
const REQUEST_TIMEOUT_MS = 20_000

// Keep service-owned fields opaque until a shared audit-bundle schema is available.
export type EvolveAuditBundle = Record<string, unknown>
export type EvolveAuditBundleClientDeps = Pick<
  HostedEvolveClientDeps,
  'baseUrl' | 'fetchImpl' | 'leaseToken'
> & { signal?: AbortSignal }

export class EvolveAuditBundleHttpError extends Error {
  constructor(readonly status: number) {
    super(`Hosted Evolve audit bundle request failed (HTTP ${status}).`)
    this.name = 'EvolveAuditBundleHttpError'
  }
}

function auditBundleUrl(cloudRunId: string, baseUrl?: string): string {
  const safeId = assertValidCloudRunId(cloudRunId)
  // URL parsers normalize these segments even when their dots are percent-encoded.
  if (safeId === '.' || safeId === '..') {
    throw new Error('Invalid hosted Evolve audit bundle cloudRunId.')
  }
  const origin = new URL(
    (baseUrl ?? process.env.OMNISI_CLOUD_URL ?? DEFAULT_OMNISI_CLOUD_URL).trim()
  )
  const localHttp =
    origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if (origin.protocol !== 'https:' && !localHttp) {
    throw new Error('Hosted Evolve audit bundle endpoint must use HTTPS or local HTTP.')
  }
  if (origin.username || origin.password) {
    throw new Error('Hosted Evolve audit bundle endpoint must not include credentials.')
  }
  return `${origin.origin}/api/evolve/runs/${encodeURIComponent(safeId)}/audit-bundle`
}

/** Read-only transport; missing endpoints remain explicit HTTP errors for older services. */
export async function fetchEvolveAuditBundle(
  cloudRunId: string,
  deps: EvolveAuditBundleClientDeps = {}
): Promise<EvolveAuditBundle> {
  const url = auditBundleUrl(cloudRunId, deps.baseUrl)
  deps.signal?.throwIfAborted()
  const token = await resolveHostedEvolveBearerToken(deps.leaseToken)
  deps.signal?.throwIfAborted()
  if (!token) {
    throw new Error('Connect your OmniRogue account in Settings before reading audit bundles.')
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout
  const response = await (deps.fetchImpl ?? fetch)(url, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    redirect: 'error',
    signal
  })
  const rejection = hostedEvolveAuthRejection(response.status)
  if (rejection || !response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw rejection ?? new EvolveAuditBundleHttpError(response.status)
  }
  const body = await readFetchResponseJsonWithinLimit<unknown>(response, MAX_RESPONSE_BYTES)
  if (!isPlainRecord(body)) {
    throw new Error('Hosted Evolve audit bundle response must be a JSON object.')
  }
  return body
}
