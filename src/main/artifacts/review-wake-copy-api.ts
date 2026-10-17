/**
 * The desktop's calls to OmniOS's wake-copy routes (CONTRACT.md, Phase 2). Every answer is one of
 * four outcomes; `unsupported` (404 without a code, or 405) means today's OmniOS lacks the routes,
 * and the callers then behave as Phase 1 for a while.
 */

import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import type { ArtifactCloudService } from './artifact-cloud-service'
import { artifactApiRequest } from './artifact-cloud-request'
import type { BuiltWakeCopy } from './review-wake-copy-source'

export type WakeCopyApiResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'unsupported' }
  | { status: 'refused'; code: string }
  | { status: 'failed' }

export type WakeCopyApiOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  bytes?: Uint8Array
  binary?: true
  timeoutMs?: number
}

export type WakeCopyApi = <T>(
  path: string,
  options?: WakeCopyApiOptions
) => Promise<WakeCopyApiResult<T>>

export function wakeCopyApiResult(error: unknown): WakeCopyApiResult<never> {
  if (!(error instanceof OrcaCloudRequestError)) {
    return { status: 'failed' }
  }
  if (error.statusCode === 405 || (error.statusCode === 404 && !error.errorCode)) {
    return { status: 'unsupported' }
  }
  return error.statusCode >= 400 && error.statusCode < 500 && error.errorCode
    ? { status: 'refused', code: error.errorCode }
    : { status: 'failed' }
}

export function wakeCopyApi(service: Pick<ArtifactCloudService, 'signedIn'>): WakeCopyApi {
  return async <T>(path: string, options: WakeCopyApiOptions = {}) => {
    try {
      const sent = await service.signedIn((token, apiUrl) =>
        artifactApiRequest<T>(apiUrl, token, `/v1/artifacts${path}`, options)
      )
      return sent.status === 'ok' ? { status: 'ok', value: sent.value } : { status: 'failed' }
    } catch (error) {
      return wakeCopyApiResult(error)
    }
  }
}

export const WAKE_COPY_PART_BYTES = 8 * 1024 * 1024
const PART_TIMEOUT_MS = 120_000

/** Begin, every part, then complete; OmniOS checks the whole copy's checksum at the end. */
export async function uploadWakeCopy(
  api: WakeCopyApi,
  input: {
    slug: string
    copy: BuiltWakeCopy
    hostId: string
    host: string
    /** Between parts: a long upload must not leave OmniOS without this computer's heartbeat. */
    beat?: () => Promise<void>
  }
): Promise<WakeCopyApiResult<unknown>> {
  const { slug, copy } = input
  const revision = copy.header.revision
  const route = `/${encodeURIComponent(slug)}/wake-copy`
  const parts = Math.max(1, Math.ceil(copy.blob.length / WAKE_COPY_PART_BYTES))
  const begun = await api(route, {
    method: 'POST',
    body: {
      revision,
      sha256: copy.sha256,
      bytes: copy.blob.length,
      parts,
      hostId: input.hostId,
      host: input.host,
      requirements: {
        provider: copy.header.provider,
        providerVersion: copy.header.writerVersion,
        workspace: copy.header.workspace
      }
    }
  })
  if (begun.status !== 'ok') {
    return begun
  }
  for (let part = 0; part < parts; part += 1) {
    await input.beat?.()
    const sent = await api(`${route}/parts/${part}?revision=${revision}`, {
      method: 'PUT',
      bytes: copy.blob.subarray(part * WAKE_COPY_PART_BYTES, (part + 1) * WAKE_COPY_PART_BYTES),
      timeoutMs: PART_TIMEOUT_MS
    })
    if (sent.status !== 'ok') {
      return sent
    }
  }
  return api(`${route}/complete`, { method: 'POST', body: { revision, hostId: input.hostId } })
}

export type WakeClaim = {
  host: string
  hostId: string
  at: string
  decisionId: string
  revision: number
  done: boolean
}

/** Who claimed the wake of this revision's session; null when nobody did. */
export async function readWakeClaim(
  api: WakeCopyApi,
  slug: string,
  revision: number
): Promise<WakeCopyApiResult<WakeClaim | null>> {
  const read = await api<{ claim?: WakeClaim | null }>(
    `/${encodeURIComponent(slug)}/wake-claim?revision=${revision}`
  )
  return read.status === 'ok' ? { status: 'ok', value: read.value?.claim ?? null } : read
}

/**
 * Takes this revision's copy off OmniOS before the session runs here. `claimed`: another computer
 * claimed it first (OmniOS refuses an owner's delete while a claim is active), so it must not wake.
 */
export async function withdrawWakeCopy(
  api: WakeCopyApi,
  slug: string
): Promise<'ok' | 'claimed' | 'failed'> {
  const sent = await api(`/${encodeURIComponent(slug)}/wake-copy`, { method: 'DELETE' })
  if (sent.status === 'refused') {
    // Why only these: a page that is gone holds no copy; any other refusal (a rate limit) proves nothing.
    return sent.code === 'wake_claimed' || sent.code === 'takeover_reserved'
      ? 'claimed'
      : sent.code === 'artifact_not_found'
        ? 'ok'
        : 'failed'
  }
  return sent.status === 'failed' ? 'failed' : 'ok'
}
