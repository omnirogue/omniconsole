import { ARTIFACT_SLUG_PATTERN } from './artifact-review'

/**
 * The IDE session an artifact was published from. The main process resolves it from the
 * terminal the CLI ran in; it only ever routes a preview, never grants anything.
 */
export type ArtifactSessionOrigin = {
  paneKey?: string
  worktreeId?: string
}

/** What `omni artifacts share|publish|update` reports from the env the IDE injected into its terminal. */
export type ArtifactWriteOrigin = ArtifactSessionOrigin & {
  terminalHandle?: string
  /** The Claude conversation the CLI ran inside, when any; a different one than the pane's never binds. */
  claudeSessionId?: string
}

/** A share or update whose command was not tied to its terminal's session, and why. */
export type ArtifactSessionBindingNotice = { state: 'unbound'; reason: string }

export function artifactSessionBindingLine(notice: ArtifactSessionBindingNotice | undefined) {
  return notice?.state === 'unbound'
    ? `session: not bound, ${notice.reason}. Decisions on this page will not be delivered to this session; read them with \`omni artifacts status <file>\`.`
    : null
}

export const ARTIFACT_ORIGIN_FIELD_MAX_CHARS = 4_096

/**
 * A share record as the renderer may see it. Why a separate shape: the stored record carries the
 * artifact's edit token, which must never cross into the renderer or a preview page.
 */
export type ArtifactSessionRecord = {
  slug: string
  shareUrl: string
  sourceKey: string
  savedAt: number | null
  /** The raw document the preview loads; the main process attaches the bearer to this URL only. */
  contentUrl: string
  origin: ArtifactSessionOrigin | null
}

/** Non-persistent and its own partition: preview pages never share storage with the app or browsing. */
export const ARTIFACT_PREVIEW_PARTITION = 'omni-artifact-preview'

export function artifactContentUrl(apiOrigin: string, slug: string): string {
  return `${apiOrigin}/a/${encodeURIComponent(slug)}/content`
}

/** The slug when `rawUrl` is exactly an artifact document on `apiOrigin`, otherwise null. */
export function parseArtifactContentUrl(rawUrl: string, apiOrigin: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.origin !== apiOrigin || url.search || url.hash || url.username || url.password) {
    return null
  }
  const match = /^\/a\/([^/]+)\/content$/.exec(url.pathname)
  const slug = match?.[1]
  return slug && ARTIFACT_SLUG_PATTERN.test(slug) ? slug : null
}

function originField(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ARTIFACT_ORIGIN_FIELD_MAX_CHARS
    ? value
    : undefined
}

/** Tolerates records written by any version: a malformed origin reads as none, never as an error. */
export function sanitizeArtifactSessionOrigin(value: unknown): ArtifactSessionOrigin | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const paneKey = originField((value as ArtifactSessionOrigin).paneKey)
  const worktreeId = originField((value as ArtifactSessionOrigin).worktreeId)
  if (!paneKey && !worktreeId) {
    return null
  }
  return { ...(paneKey ? { paneKey } : {}), ...(worktreeId ? { worktreeId } : {}) }
}
