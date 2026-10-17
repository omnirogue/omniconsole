import type { BackofficeFeedResult } from '../../shared/backoffice-work-types'
import { isInboxFeedPath } from '../../shared/inbox-feed-path'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'

/** An Inbox feed failure the gateway explained, or undefined to answer it the generic way. */
export async function inboxFeedFailure(
  path: string,
  response: Response
): Promise<BackofficeFeedResult | undefined> {
  if (!isInboxFeedPath(path)) {
    return undefined
  }
  if (response.status >= 500) {
    const failure = await readFetchResponseJsonWithinLimit<{
      error?: { message?: unknown }
    }>(response).catch(() => null)
    const detail = failure?.error?.message
    return {
      ok: false,
      message:
        typeof detail === 'string' && detail.trim()
          ? `${detail.slice(0, 500)} (HTTP ${response.status})`
          : `The backoffice answered HTTP ${response.status}.`
    }
  }
  if (response.status === 401) {
    const failure: unknown = await response.json().catch(() => null)
    // Why: peer routes relay hub failures; those must not revoke a valid desktop session.
    if (failure && typeof failure === 'object' && 'error' in failure) {
      return {
        ok: false,
        message:
          'The message feed could not authenticate with the hub (HTTP 401). Your desktop account has not been signed out.'
      }
    }
  }
  return undefined
}
