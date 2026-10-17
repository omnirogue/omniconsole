/**
 * Main-process view of the active backoffice connection.
 *
 * Holds a snapshot of the resolved base URL, synced from GlobalSettings at
 * boot and on every settings update, so modules that cannot reach the store
 * (notably profile-cloud-auth-config) read one place. Fail-closed: an
 * unconfigured or invalid URL yields `configured: false`, never a guess.
 */

import type {
  BackofficeConnectionSettings,
  BackofficeConnectionTest,
  ResolvedBackoffice
} from '../../shared/backoffice-connection'
import {
  DEFAULT_BACKOFFICE_ENV,
  resolveBackofficeBaseUrl
} from '../../shared/backoffice-connection'

const connectionListeners = new Set<() => void>()

export function subscribeBackofficeConnectionChanges(listener: () => void): () => void {
  connectionListeners.add(listener)
  return () => {
    connectionListeners.delete(listener)
  }
}

let snapshot: ResolvedBackoffice = {
  configured: false,
  env: DEFAULT_BACKOFFICE_ENV,
  message: 'Backoffice connection not initialized yet.'
}

export function syncBackofficeFromSettings(settings: BackofficeConnectionSettings): void {
  const next = resolveBackofficeBaseUrl(settings)
  const changed = JSON.stringify(next) !== JSON.stringify(snapshot)
  snapshot = next
  if (changed) {
    for (const listener of connectionListeners) {
      try {
        listener()
      } catch {
        /* A view must not fail a settings change. */
      }
    }
  }
}

export function getBackofficeSnapshot(): ResolvedBackoffice {
  return snapshot
}

export type { BackofficeConnectionTest } from '../../shared/backoffice-connection'

/**
 * Probe a backoffice base URL (the one being edited, not the snapshot):
 * GET <base>/healthz with a short timeout. Read-only, no credentials.
 */
export async function testBackofficeConnection(baseUrl: string): Promise<BackofficeConnectionTest> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/healthz`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    })
  } catch (error) {
    return {
      ok: false,
      url: baseUrl,
      message: `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, url: baseUrl, message: `The server answered HTTP ${response.status}.` }
  }
  let detail = 'healthy'
  try {
    const body = (await response.json()) as { hub?: { ok?: boolean }; agent?: { ok?: boolean } }
    const hub = body?.hub?.ok === true ? 'hub ok' : 'hub unreachable'
    const agent = body?.agent?.ok === true ? 'agent ok' : 'no local agent'
    detail = `${hub} · ${agent}`
  } catch {
    // A non-JSON 200 is still a live server; keep the generic detail.
  }
  return { ok: true, url: baseUrl, status: response.status, detail }
}
