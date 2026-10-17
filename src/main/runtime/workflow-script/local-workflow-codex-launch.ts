import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Codex refreshes a ChatGPT login on its own once the last refresh is this old (codex-rs
 * `TOKEN_REFRESH_INTERVAL`, 8 days; older CLIs waited 28, so 8 is the earlier of the two).
 */
export const WORKFLOW_CODEX_REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60_000
/** A Codex login must outlast a run by this much before runs share the account. */
export const WORKFLOW_CODEX_LOGIN_MARGIN_MS = 30 * 60_000

type CodexAuth = {
  tokens?: { access_token?: unknown; refresh_token?: unknown } | null
  last_refresh?: unknown
}

function tokenExpiry(token: unknown): number | undefined {
  if (typeof token !== 'string') {
    return undefined
  }
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const exp = (payload as { exp?: unknown } | null)?.exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function lastRefresh(value: unknown): number | undefined {
  const time =
    typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(time) ? time : undefined
}

/**
 * When Codex will next refresh this auth.json's login: when its access token expires or when its
 * last refresh turns stale, whichever comes first. `null` when the login has no rotating refresh
 * token (an API key), so there is nothing to refresh; `undefined` when that cannot be told. Only
 * the expiry leaves this function: no token is logged, copied or returned.
 */
export function workflowCodexRefreshDue(text: string): number | null | undefined {
  let auth: CodexAuth
  try {
    auth = JSON.parse(text) as CodexAuth
  } catch {
    return undefined
  }
  if (!auth || typeof auth !== 'object') {
    return undefined
  }
  if (!auth.tokens || typeof auth.tokens.refresh_token !== 'string') {
    return null
  }
  return workflowCodexRefreshDueAt(tokenExpiry(auth.tokens.access_token), auth.last_refresh)
}

/** The earlier of the access expiry and the last refresh turning stale; `undefined` without both. */
export function workflowCodexRefreshDueAt(
  expires: number | undefined,
  lastRefreshed: unknown
): number | undefined {
  const refreshed = lastRefresh(lastRefreshed)
  return expires === undefined || refreshed === undefined
    ? undefined
    : Math.min(expires, refreshed + WORKFLOW_CODEX_REFRESH_INTERVAL_MS)
}

/** Whether a login due then could refresh within `withinMs`; an unknown due time counts as due. */
export function workflowCodexRefreshDueWithin(
  due: number | null | undefined,
  withinMs: number
): boolean {
  return due !== null && (due === undefined || due - Date.now() < withinMs)
}

/**
 * Whether a Codex run of `withinMs` on this account home could refresh its rotating login. Two
 * runs refreshing one home at once can spend one rotation twice and sign the account out, so such
 * runs take the account one at a time; a login that stays valid well past the run lets runs go
 * in parallel. Anything unreadable counts as due, which keeps the one-at-a-time default.
 */
export async function workflowCodexLoginRefreshesWithin(
  codexHome: string,
  withinMs: number
): Promise<boolean> {
  const text = await readFile(join(codexHome, 'auth.json'), 'utf8').catch(() => undefined)
  return workflowCodexRefreshDueWithin(
    text === undefined ? undefined : workflowCodexRefreshDue(text),
    withinMs
  )
}
