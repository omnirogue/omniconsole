import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { readBackofficeCached } from './backoffice-read-cache'
import { isBoardTaskId } from '../../shared/board-task-id'
import { isInboxFeedPath } from '../../shared/inbox-feed-path'
import { inboxFeedFailure } from './inbox-feed-failure'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
/**
 * Member work feeds from the active backoffice (main-process only).
 *
 * The renderer never fetches the backoffice directly: this module is the one
 * place the base URL is resolved (settings-synced snapshot, fail-closed) and
 * the one place the Authorization: Bearer header is added — tokens
 * must never reach the renderer.
 */

import {
  BACKOFFICE_TODO_CURSOR,
  type BackofficeArchiveResult,
  type BackofficeFeedResult,
  type BackofficeTaskCompletionResult,
  type BackofficeTodoListArgs,
  type BackofficeTodoResult
} from '../../shared/backoffice-work-types'
import { currentBearerToken } from './backoffice-auth'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from '../omni-profiles/profile-cloud-session-refresh'
import { getBackofficeSnapshot } from './backoffice-config'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import { asString, normalizeTodoPayload, type RawTodoPayload } from './backoffice-todo-payload'
import { refusalTag } from './backoffice-refusal-tag'

export async function fetchBackofficeTodo(
  args: BackofficeTodoListArgs = {}
): Promise<BackofficeTodoResult> {
  const cursor = typeof args.cursor === 'string' ? args.cursor : null
  // Why: a page position comes from a previous answer; anything else never becomes a request.
  if (cursor !== null && !BACKOFFICE_TODO_CURSOR.test(cursor)) {
    return { ok: false, message: 'That is not a Todo page position.' }
  }
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return { ok: false, message: snapshot.message }
  }
  const bearer = await currentBearerToken()
  let response: Response
  let cachedRead: Awaited<ReturnType<typeof readBackofficeCached>>
  try {
    cachedRead = await readBackofficeCached(
      `${snapshot.baseUrl}/api/work/todo${cursor ? `?cursor=${cursor}` : ''}`,
      bearer ?? undefined
    )
    response = cachedRead.response
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach ${snapshot.baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
  if (response.status === 401 || response.status === 403) {
    await cancelUnreadResponseBody(response)
    return {
      ok: false,
      message: bearer
        ? `The backoffice refused your session (HTTP ${
            response.status
          }) — sign in again under Settings → OmniConsole Account.`
        : `Sign in under Settings → OmniConsole Account to see your tasks (HTTP ${
            response.status
          }).`
    }
  }
  if (!response.ok && !cachedRead.notModified) {
    // Why: a page position whose snapshot the console let go is not a failure; the walk restarts.
    if ((await refusalTag(response)) === 'todo-page-stale') {
      return { ok: false, message: 'That Todo page position expired.', stale: true }
    }
    return { ok: false, message: `The backoffice answered HTTP ${response.status}.` }
  }
  const payload = cachedRead.body as RawTodoPayload
  if (payload.ok === false) {
    return {
      ok: false,
      message:
        asString(payload.reason) ??
        asString(payload.detail) ??
        'The backoffice refused the todo feed.'
    }
  }
  const result = normalizeTodoPayload(payload, snapshot.baseUrl)
  return result.ok && cachedRead.notModified ? { ...result, notModified: true } : result
}

type RawTaskMutationError = Record<string, unknown>

const DONE_GATE_WANTS_EVIDENCE = /cannot be done without evidence/i

export async function completeBackofficeTask(
  taskId: string,
  expectedRevision: number,
  resultRef?: string
): Promise<BackofficeTaskCompletionResult> {
  return patchBackofficeTask(taskId, expectedRevision, {
    status: 'done',
    ...(resultRef?.trim() ? { result_ref: resultRef.trim() } : {})
  })
}

async function patchBackofficeTask(
  taskId: string,
  expectedRevision: number,
  fields: Record<string, string>
): Promise<BackofficeTaskCompletionResult> {
  if (!isBoardTaskId(taskId)) {
    return { ok: false, message: 'That is not a backoffice card id.' }
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, message: 'That task does not have a valid state revision.' }
  }
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return { ok: false, message: snapshot.message }
  }
  const bearer = await currentBearerToken()
  if (!bearer) {
    return {
      ok: false,
      message: 'Sign in under Settings → OmniConsole Account to complete your tasks.'
    }
  }

  let response: Response
  try {
    response = await fetch(`${snapshot.baseUrl}/api/collab/board/${taskId}`, {
      method: 'PATCH',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expected_revision: expectedRevision, ...fields })
    })
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach ${snapshot.baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  try {
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        message: `The backoffice refused the change (HTTP ${response.status}) — sign in again under Settings → OmniConsole Account.`
      }
    }
    if (!response.ok) {
      let payload: RawTaskMutationError | null = null
      try {
        payload = await readFetchResponseJsonWithinLimit<RawTaskMutationError>(response)
      } catch {
        // Preserve the HTTP refusal when its body cannot be read.
      }
      const message =
        (typeof payload?.error === 'object' && payload.error !== null
          ? asString((payload.error as Record<string, unknown>).message)
          : null) ??
        asString(payload?.reason) ??
        asString(payload?.detail) ??
        asString(payload?.message) ??
        asString(payload?.error) ??
        `The backoffice answered HTTP ${response.status}.`
      return {
        ok: false,
        message,
        ...(response.status === 409 ? { stale: true } : {}),
        ...(DONE_GATE_WANTS_EVIDENCE.test(message) ? { needsEvidence: true } : {})
      }
    }

    return { ok: true }
  } finally {
    await cancelUnreadResponseBody(response)
  }
}

/**
 * Archive a card through the backoffice without changing its completion state.
 *
 * Same posture as the todo fetch: the base URL and the bearer token are
 * resolved HERE, never in the renderer. The bearer is what lets this mutate at
 * all — the backoffice's CSRF gate accepts a valid bearer principal in place of
 * its browser session cookie, so no cookie plumbing is needed.
 */
export async function archiveBackofficeTask(taskId: string): Promise<BackofficeArchiveResult> {
  if (!isBoardTaskId(taskId)) {
    return { ok: false, message: 'That is not a backoffice card id.' }
  }
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return { ok: false, message: snapshot.message }
  }
  const bearer = await currentBearerToken()
  let response: Response
  try {
    response = await fetch(`${snapshot.baseUrl}/api/board/${taskId}/archive`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      },
      body: '{}'
    })
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach ${snapshot.baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
  await cancelUnreadResponseBody(response)
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: bearer
        ? `The backoffice refused the change (HTTP ${response.status}) — sign in again under Settings → OmniConsole Account.`
        : `Sign in under Settings → OmniConsole Account to change your tasks (HTTP ${response.status}).`
    }
  }
  if (!response.ok) {
    return { ok: false, message: `The backoffice answered HTTP ${response.status}.` }
  }
  return { ok: true }
}

/**
 * The read-only feeds the vendored 3D office renders from.
 *
 * An exact-path allowlist, not a prefix: the office is the only caller, its four
 * feeds are known, and a renderer-supplied path must never become a way to reach
 * the rest of the backoffice through this app's bearer.
 */
const OFFICE_FEED_PATHS = new Set([
  '/api/sessions',
  '/api/dispatch',
  '/api/health',
  '/api/usage',
  '/api/jobs'
])

/** GET one allowlisted backoffice feed. Never throws; a dead backoffice is data. */
export async function fetchBackofficeFeed(path: string): Promise<BackofficeFeedResult> {
  if (!OFFICE_FEED_PATHS.has(path) && !isInboxFeedPath(path)) {
    return { ok: false, message: `Not an office feed: ${path}` }
  }
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return { ok: false, message: snapshot.message }
  }
  const signInMessage =
    'Sign in again under Settings → OmniConsole Account, then refresh Work (HTTP 401).'
  try {
    const readFeed = async (bearer?: string): Promise<BackofficeFeedResult> => {
      const cached = await readBackofficeCached(`${snapshot.baseUrl}${path}`, bearer)
      const { response } = cached
      if (cached.notModified) {
        return { ok: true, body: cached.body, notModified: true }
      }
      if (!response.ok) {
        const inboxFailure = await inboxFeedFailure(path, response)
        if (inboxFailure) {
          return inboxFailure
        }
        await cancelUnreadResponseBody(response)
        // Why: the request must run inside the refresh operation to retry a rejected token.
        if (response.status === 401 && bearer) {
          throw new OrcaCloudRequestError(401)
        }
        return {
          ok: false,
          message:
            response.status === 401
              ? signInMessage
              : response.status === 403
                ? 'Your account does not have access to this feed (HTTP 403).'
                : `The backoffice answered HTTP ${response.status}.`
        }
      }
      return { ok: true, body: cached.body }
    }
    const config = getOrcaCloudAuthConfig()
    if (!config.configured) {
      return await readFeed()
    }
    const userDataPath = getProfileUserDataPath()
    const active = ensureActiveOrcaProfile(userDataPath)
    const result = await runWithFreshOrcaCloudSession(
      config.config,
      active,
      userDataPath,
      (session) => readFeed(session.accessToken)
    )
    // Why: local mode-off backoffices also support anonymous read-only feeds.
    if (result.status === 'ok') {
      return result.value
    }
    const hostname = new URL(snapshot.baseUrl).hostname
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
      ? await readFeed()
      : { ok: false, message: signInMessage }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
