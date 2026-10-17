import { app } from 'electron'

// Why omnios (2026-09-07): sharing is hosted with the sign-in, never on a third-party cloud.
const PRODUCTION_ARTIFACTS_API_URL = 'https://console.example.com'
const FIRST_PARTY_DOMAINS = ['omnirogue.com'] as const

function isPackaged(): boolean {
  try {
    return app?.isPackaged === true
  } catch {
    return false
  }
}

export function resolveArtifactCloudApiUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged()
): string {
  const candidate = override?.trim() || env.ORCA_ARTIFACTS_API_URL?.trim()
  const url = new URL(candidate || PRODUCTION_ARTIFACTS_API_URL)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const firstParty = FIRST_PARTY_DOMAINS.some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
  )
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !packaged)) {
    throw new Error('Artifact API URLs must use HTTPS; local development may use loopback HTTP.')
  }
  if (!firstParty && !loopback) {
    throw new Error('Artifact API URLs must use an omnirogue.com or loopback host.')
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Artifact API URL must be an origin without credentials, paths, or parameters.')
  }
  return url.origin
}

/** `resolveArtifactCloudApiUrl()` for readers that must not throw on a misconfigured override. */
export function artifactCloudApiOriginOrNull(): string | null {
  try {
    return resolveArtifactCloudApiUrl()
  } catch {
    return null
  }
}

export function allowsArtifactCloudAuthOverride(
  env: NodeJS.ProcessEnv = process.env,
  packaged = isPackaged()
): boolean {
  return env.NODE_ENV !== 'production' && !packaged
}
