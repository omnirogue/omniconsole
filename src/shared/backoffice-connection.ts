/**
 * Backoffice connection settings (go-live plan P4).
 *
 * The backoffice is our control plane: a FastAPI BFF + SPA that serves
 * identity, member-scoped tasks, QA, inbox and knowledge. The IDE talks to
 * exactly ONE backoffice at a time, chosen by `backofficeEnv`:
 *  - `local`      → the developer loopback instance (plain HTTP allowed)
 *  - `production` → the public origin (HTTPS required — a user pasting an
 *    http:// production URL is either a mistake or a downgrade attack;
 *    refuse loudly rather than send tokens in the clear).
 *
 * `production` is the DEFAULT: the console people install this app to reach is
 * the live site, and a loopback backoffice is a developer's deliberate choice.
 * A fresh profile that never picked an environment used to point at
 * 127.0.0.1:4477 and greeted its owner with `fetch failed` on every task, inbox
 * and job view. Only an explicitly stored `'local'` opts out — we never rewrite
 * what a profile already saved on disk.
 */

export type BackofficeEnv = 'local' | 'production'

export const DEFAULT_BACKOFFICE_LOCAL_URL = 'http://127.0.0.1:4477'

/** The live OmniConsole; used whenever no production URL was configured. */
export const DEFAULT_BACKOFFICE_PRODUCTION_URL = 'https://console.example.com'

/** Environment a profile lands on when it never chose one. */
export const DEFAULT_BACKOFFICE_ENV: BackofficeEnv = 'production'

export type BackofficeConnectionSettings = {
  backofficeEnv?: BackofficeEnv
  backofficeLocalUrl?: string
  backofficeProductionUrl?: string
}

export type NormalizedBackofficeUrl = { ok: true; value: string } | { ok: false; message: string }

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/** Validate + canonicalize one backoffice base URL (no trailing slash). */
export function normalizeBackofficeUrl(
  value: string | undefined,
  { requireHttps }: { requireHttps: boolean }
): NormalizedBackofficeUrl {
  const trimmed = value?.trim()
  if (!trimmed) {
    return { ok: false, message: 'Enter a backoffice URL.' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, message: 'Enter a full URL, like https://console.example.com.' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'The backoffice URL must start with https:// or http://.' }
  }
  if (parsed.protocol === 'http:' && (requireHttps || !isLoopbackHost(parsed.hostname))) {
    return {
      ok: false,
      message: 'Non-local backoffice URLs must use https:// — sign-in tokens ride this connection.'
    }
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, message: 'Use a bare origin URL — no query or fragment.' }
  }
  return { ok: true, value: parsed.toString().replace(/\/+$/, '') }
}

/**
 * Read a stored/incoming environment. Only an explicit `'local'` selects the
 * loopback backoffice; anything else — including `undefined` on a fresh
 * profile — resolves to the production console.
 */
export function normalizeBackofficeEnv(value: unknown): BackofficeEnv {
  return value === 'local' ? 'local' : DEFAULT_BACKOFFICE_ENV
}

export type ResolvedBackoffice =
  | { configured: true; env: BackofficeEnv; baseUrl: string }
  | { configured: false; env: BackofficeEnv; message: string }

/** The active backoffice base URL for the current settings, fail-closed. */
export function resolveBackofficeBaseUrl(
  settings: BackofficeConnectionSettings
): ResolvedBackoffice {
  const env = normalizeBackofficeEnv(settings.backofficeEnv)
  // An empty production URL means "not configured", so fall back to the live
  // console. A non-empty one is honoured verbatim, including when it fails
  // validation — a bad URL must surface, never be silently replaced.
  const raw =
    env === 'production'
      ? settings.backofficeProductionUrl?.trim()
        ? settings.backofficeProductionUrl
        : DEFAULT_BACKOFFICE_PRODUCTION_URL
      : (settings.backofficeLocalUrl ?? DEFAULT_BACKOFFICE_LOCAL_URL)
  const normalized = normalizeBackofficeUrl(raw, { requireHttps: env === 'production' })
  if (!normalized.ok) {
    return {
      configured: false,
      env,
      message:
        env === 'production'
          ? 'Set the production backoffice URL in Settings → Backoffice.'
          : normalized.message
    }
  }
  return { configured: true, env, baseUrl: normalized.value }
}

export type BackofficeConnectionTest =
  | { ok: true; url: string; status: number; detail: string }
  | { ok: false; url: string | null; message: string }
