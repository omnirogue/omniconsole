import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import {
  accountSyncValueSize,
  ACCOUNT_SYNC_KEY,
  ACCOUNT_SYNC_KEY_PREFIX,
  ACCOUNT_SYNC_VALUE_MAX_BYTES,
  type AccountSyncReadResult,
  type AccountSyncWriteArgs,
  type AccountSyncWriteResult
} from '../../shared/account-sync-types'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { getOrcaCloudAuthConfig } from '../omni-profiles/profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from '../omni-profiles/profile-cloud-session-refresh'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import { getBackofficeSnapshot } from './backoffice-config'

const SIGNED_OUT = 'Sign in under Settings → OmniConsole Account to sync session folders.'
const TIMEOUT_MS = 15_000

/**
 * Runs one omnios request as the signed-in person, refreshing the session once on a 401. The
 * bearer token stays in the main process; the renderer only sees the result.
 */
async function asSignedInPerson<T extends { ok: boolean }>(
  request: (baseUrl: string, bearer: string) => Promise<T>
): Promise<T | { ok: false; message: string }> {
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return { ok: false, message: snapshot.message }
  }
  const config = getOrcaCloudAuthConfig()
  if (!config.configured) {
    return { ok: false, message: SIGNED_OUT }
  }
  try {
    const userDataPath = getProfileUserDataPath()
    const result = await runWithFreshOrcaCloudSession(
      config.config,
      ensureActiveOrcaProfile(userDataPath),
      userDataPath,
      (session) => request(snapshot.baseUrl, session.accessToken)
    )
    return result.status === 'ok' ? result.value : { ok: false, message: SIGNED_OUT }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

async function refuseUnlessOk(response: Response): Promise<string | null> {
  if (response.ok) {
    return null
  }
  await cancelUnreadResponseBody(response)
  // Why: thrown inside the refresh operation so a rejected token is refreshed and retried once.
  if (response.status === 401) {
    throw new OrcaCloudRequestError(401)
  }
  return `omnios answered HTTP ${response.status}.`
}

/** The signed-in person's session-sync documents: every preference under this app's prefix. */
export async function readAccountSyncPrefs(): Promise<AccountSyncReadResult> {
  return asSignedInPerson(async (baseUrl, bearer): Promise<AccountSyncReadResult> => {
    const response = await fetch(`${baseUrl}/api/gtd/prefs`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const refused = await refuseUnlessOk(response)
    if (refused) {
      return { ok: false, message: refused }
    }
    const body = await readFetchResponseJsonWithinLimit<{
      user?: unknown
      prefs?: Record<string, { value?: unknown } | undefined>
    }>(response)
    if (typeof body.user !== 'string' || !body.user || !body.prefs) {
      return { ok: false, message: 'omnios answered without a signed-in person.' }
    }
    const prefs: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(body.prefs)) {
      if (key.startsWith(ACCOUNT_SYNC_KEY_PREFIX) && entry && 'value' in entry) {
        prefs[key] = entry.value
      }
    }
    return { ok: true, user: body.user, prefs }
  })
}

/**
 * Writes one session-sync document for the signed-in person. `expectedUser` makes omnios refuse
 * the write when the account changed since the documents were read.
 */
export async function writeAccountSyncPref(
  args: AccountSyncWriteArgs
): Promise<AccountSyncWriteResult> {
  if (typeof args?.key !== 'string' || !ACCOUNT_SYNC_KEY.test(args.key)) {
    return { ok: false, message: 'Not a session sync key.' }
  }
  if (typeof args.expectedUser !== 'string' || !args.expectedUser) {
    return { ok: false, message: 'A session sync write needs the account it was read for.' }
  }
  let body: string
  try {
    if (accountSyncValueSize(args.value) > ACCOUNT_SYNC_VALUE_MAX_BYTES) {
      return { ok: false, message: 'A session sync document is at most 32 KB.' }
    }
    body = JSON.stringify({ value: args.value, expected_user: args.expectedUser })
  } catch {
    return { ok: false, message: 'A session sync document must be JSON.' }
  }
  return asSignedInPerson(async (baseUrl, bearer): Promise<AccountSyncWriteResult> => {
    const response = await fetch(`${baseUrl}/api/gtd/prefs/${encodeURIComponent(args.key)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (response.status === 409) {
      await cancelUnreadResponseBody(response)
      return { ok: false, message: 'The signed-in account changed.', accountChanged: true }
    }
    const refused = await refuseUnlessOk(response)
    if (refused) {
      return { ok: false, message: refused }
    }
    await cancelUnreadResponseBody(response)
    return { ok: true }
  })
}
