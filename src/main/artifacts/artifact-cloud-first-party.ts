/**
 * Why (2026-09-07): the Artifacts and Skills sharing features are Orca's cloud
 * product and default to `share.onorca.dev`. OmniConsole signs people in to
 * omnios instead, so those requests carried an omnios bearer token to a
 * third-party host, got 401, and the session-refresh logic read that 401 as an
 * expired sign-in and CLEARED the stored session — every visit to Artifacts
 * signed the person out. No token may leave for a host that is not ours.
 */
function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split('.').filter(Boolean)
  return labels.length <= 2 ? labels.join('.') : labels.slice(-2).join('.')
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

/** True when `apiUrl` belongs to the same organization as the sign-in API (or is loopback). */
export function isFirstPartyCloudHost(apiUrl: string, authApiBaseUrl: string): boolean {
  try {
    const api = new URL(apiUrl)
    const auth = new URL(authApiBaseUrl)
    if (isLoopback(api.hostname)) {
      return true
    }
    return api.hostname === auth.hostname || registrableDomain(api.hostname) === registrableDomain(auth.hostname)
  } catch {
    return false
  }
}

export const THIRD_PARTY_CLOUD_MESSAGE =
  'Sharing is not set up on this OmniConsole yet: the sharing service is not hosted with your sign-in, so no token is sent to it.'
