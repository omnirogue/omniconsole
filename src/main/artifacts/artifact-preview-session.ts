import { session } from 'electron'
import { ARTIFACT_PREVIEW_PARTITION, parseArtifactContentUrl } from '../../shared/artifact-session'
import { applyProxyToBrowserSession } from '../browser/browser-session-proxy'
import { getProxySessionApplicationReadiness } from '../network/proxy-settings'
import { resolveArtifactCloudApiUrl } from './artifact-cloud-config'

/** Resolves the signed-in desktop bearer for the artifact API, or null to load without one. */
export type ArtifactPreviewTokenProvider = (apiOrigin: string) => Promise<string | null>

let artifactPreviewSession: Electron.Session | null = null

function getArtifactPreviewSession(): Electron.Session {
  artifactPreviewSession ??= session.fromPartition(ARTIFACT_PREVIEW_PARTITION)
  return artifactPreviewSession
}

/** Pure identity check: every guest attach consults it, and none should materialize a session. */
export function isArtifactPreviewSession(candidate: Electron.Session): boolean {
  return artifactPreviewSession !== null && candidate === artifactPreviewSession
}

function currentApiOrigin(): string | null {
  try {
    return resolveArtifactCloudApiUrl()
  } catch {
    return null
  }
}

/** Only the preview partition, and only a raw artifact document on the configured API, may attach. */
export function isAdmissibleArtifactPreviewAttach(partition: string, src: string): boolean {
  const apiOrigin = currentApiOrigin()
  return (
    partition === ARTIFACT_PREVIEW_PARTITION &&
    apiOrigin !== null &&
    parseArtifactContentUrl(src, apiOrigin) !== null
  )
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

function isLoopbackHost(hostname: string): boolean {
  return (
    LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.startsWith('127.')
  )
}

/**
 * Artifacts are pages written for a normal browser, so CDN scripts, fonts and images must load.
 * What they may not reach is this machine: no `file:` reads and no loopback services (the IDE's
 * own local endpoints live there). The configured API origin is the one loopback exception, for
 * local development of the artifact server.
 */
export function isAllowedArtifactPreviewRequestUrl(
  rawUrl: string,
  apiOrigin: string | null
): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'devtools:') {
    return true
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    return false
  }
  if (!isLoopbackHost(url.hostname)) {
    return true
  }
  return apiOrigin !== null && url.origin === apiOrigin
}

type BeforeSendHeadersDetails = {
  url: string
  resourceType: string
  requestHeaders: Record<string, string>
}

/**
 * Why the bearer is added here and nowhere else: the network stack runs in the main process, so
 * the token never enters the renderer or the page, and page script cannot read request headers.
 * Only a top-level load of an artifact document gets it — a subframe, fetch, image or redirect
 * target does not, so a page cannot borrow the credential for any other request.
 */
export async function artifactPreviewRequestHeaders(
  details: BeforeSendHeadersDetails,
  getToken: ArtifactPreviewTokenProvider,
  apiOrigin: string | null
): Promise<Record<string, string> | null> {
  if (
    details.resourceType !== 'mainFrame' ||
    apiOrigin === null ||
    parseArtifactContentUrl(details.url, apiOrigin) === null
  ) {
    return null
  }
  const token = await getToken(apiOrigin).catch(() => null)
  return token ? { ...details.requestHeaders, Authorization: `Bearer ${token}` } : null
}

function installArtifactPreviewSessionPolicies(previewSession: Electron.Session): void {
  // Why deny: a preview is for reading. Camera, notifications, downloads and the like belong in
  // the browser, which is one click away with the person's own session.
  previewSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  )
  previewSession.setPermissionCheckHandler(() => false)
  previewSession.on('will-download', (event) => event.preventDefault())
  // Why: honour the app-wide network proxy like every other embedded page does.
  void applyProxyToBrowserSession(previewSession).catch(() => {})
}

/**
 * Why its own hooks rather than the shared browser-partition installer: that installer claims the
 * session's single onBeforeRequest slot (certificate guard) and, in clean-UA mode, its single
 * onBeforeSendHeaders slot, either of which would silently replace the filter or the bearer hook.
 */
export function installArtifactPreviewSession(getToken: ArtifactPreviewTokenProvider): void {
  const previewSession = getArtifactPreviewSession()
  installArtifactPreviewSessionPolicies(previewSession)
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedArtifactPreviewRequestUrl(details.url, currentApiOrigin())
    const readiness = allowed ? getProxySessionApplicationReadiness(previewSession) : false
    const answer = (ready: boolean): void => callback(ready ? {} : { cancel: true })
    if (typeof readiness === 'boolean') {
      answer(readiness)
    } else {
      void readiness.then(answer, () => answer(false))
    }
  })
  previewSession.webRequest.onBeforeSendHeaders((details, callback) => {
    void artifactPreviewRequestHeaders(details, getToken, currentApiOrigin()).then(
      (requestHeaders) => callback(requestHeaders ? { requestHeaders } : {}),
      () => callback({})
    )
  })
}
