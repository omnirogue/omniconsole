import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { SelectedAccountUsageRequest } from '../../shared/fleet-account-usage'
import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { getMainHttpClient } from '../network/http-client'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { fetchCodexRateLimitsViaBackend } from './codex-backend-usage-client'
import { parseGrokAuthSession } from './grok-auth'
import { fetchGrokRateLimits } from './grok-fetcher'
import { fetchKimiRateLimitsWithToken } from './kimi-fetcher'

const PROBE_TIMEOUT_MS = 10_000
const MAX_CREDENTIAL_BYTES = 65_536

function unavailable(
  provider: SelectedAccountUsageRequest['provider'],
  failureKind: UsageRateLimitFailureKind = 'usage-unavailable',
  status: 'error' | 'unavailable' = 'error'
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Selected account usage is unavailable',
    status,
    usageMetadata: { failureKind }
  }
}

async function credentialFile(file: string, signal: AbortSignal): Promise<string | null> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      if (!info.isFile()) {
        return null
      }
      if (info.size > MAX_CREDENTIAL_BYTES) {
        throw new Error('Invalid selected credential')
      }
      // A file may grow after stat. Read at most the cap plus one byte from
      // this handle, rather than allowing readFile to allocate the new size.
      const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) {
          break
        }
        length += bytesRead
      }
      signal.throwIfAborted()
      if (length > MAX_CREDENTIAL_BYTES) {
        throw new Error('Invalid selected credential')
      }
      return buffer.toString('utf8', 0, length)
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    throw error
  }
}

function fingerprint(source: string, value: string): string {
  return createHash('sha256').update(source).update('\0').update(value).digest('hex')
}

// A login token with at least this long to live still answers the usage endpoint.
const LOGIN_TOKEN_MIN_REMAINING_MS = 60_000

async function claudeLoginCredential(root: string, signal: AbortSignal, now: number) {
  const raw = await credentialFile(join(root, '.credentials.json'), signal)
  if (raw === null) {
    return null
  }
  const parsed = JSON.parse(raw) as {
    claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown }
  }
  const token = parsed?.claudeAiOauth?.accessToken
  if (typeof token !== 'string' || !token.trim()) {
    return null
  }
  const expiresAt = parsed?.claudeAiOauth?.expiresAt
  // Why: Claude stores expiresAt in Unix milliseconds; a missing stamp is treated as live.
  const live =
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    expiresAt - now > LOGIN_TOKEN_MIN_REMAINING_MS
  return { token: token.trim(), revision: fingerprint('.credentials.json', raw), live }
}

async function claudeCredential(
  root: string,
  signal: AbortSignal,
  now = Date.now(),
  loginOnly = false
) {
  // Why: the usage endpoint answers a login (claude.ai OAuth) token but refuses a
  // `claude setup-token` credential with 429 (measured 2026-09-14 on the fleet), while the
  // runner runs its jobs on the setup token. Usage therefore reads the live login credential
  // first and falls back to the setup token only when no live login exists. The general
  // desktop reader may fall back to an unrelated legacy Keychain; this reader never does.
  const login = await claudeLoginCredential(root, signal, now)
  if (login?.live) {
    return { token: login.token, revision: login.revision }
  }
  if (loginOnly) {
    return null
  }
  const setupToken = (await credentialFile(join(root, '.oauth-token'), signal))?.trim()
  if (setupToken) {
    return { token: setupToken, revision: fingerprint('.oauth-token', setupToken) }
  }
  return login ? { token: login.token, revision: login.revision } : null
}

function kimiCodingBaseUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' &&
      url.hostname === 'api.kimi.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['/coding/v1', '/coding/v1/'].includes(url.pathname)
      ? 'https://api.kimi.com/coding/v1'
      : null
  } catch {
    return null
  }
}

async function codexUsage(root: string, snapshot: string, signal: AbortSignal) {
  const auth = JSON.parse(snapshot) as {
    OPENAI_API_KEY?: unknown
    tokens?: { access_token?: unknown; account_id?: unknown }
  }
  // API-key logins can retain stale subscription tokens in the same file.
  // Match CodexAccountIdentity: those tokens do not identify the active login.
  if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
    return null
  }
  const token = auth?.tokens?.access_token
  const accountId = auth?.tokens?.account_id
  if (typeof token !== 'string' || !token) {
    return null
  }
  if (accountId != null && typeof accountId !== 'string') {
    return null
  }
  return fetchCodexRateLimitsViaBackend(
    (url, init) => {
      // The existing backend reader reads auth again. Refuse a different
      // credential before sending a request, even if a file is later restored.
      const headers = new Headers(init.headers)
      if (
        headers.get('Authorization') !== `Bearer ${token}` ||
        headers.get('ChatGPT-Account-Id') !== (accountId || null)
      ) {
        throw new Error('Selected credential changed')
      }
      // Why the port, not the global: it keeps the audited call site in one place and
      // gives the desktop Chromium's stack while the runtime boots on plain Node.
      return getMainHttpClient().fetch(url, init)
    },
    { codexHomePath: root, signal }
  )
}

async function probe(
  input: SelectedAccountUsageRequest,
  signal: AbortSignal,
  claudeLoginOnly: boolean
): Promise<ProviderRateLimits> {
  if (input.provider === 'kimi') {
    const token = input.token.trim()
    const baseUrl = kimiCodingBaseUrl(input.baseUrl)
    if (!token || !baseUrl) {
      return unavailable('kimi', 'usage-unavailable', 'unavailable')
    }
    return fetchKimiRateLimitsWithToken({ token, baseUrl, signal })
  }

  if (!input.configRoot.trim() || !isAbsolute(input.configRoot)) {
    return unavailable(input.provider, 'missing-credentials', 'unavailable')
  }
  if (input.provider === 'claude' && input.token !== undefined) {
    const token = input.token.trim()
    // An explicit private request token is the runner's selected credential;
    // an empty override must not quietly switch to a file or desktop login.
    return token
      ? fetchClaudeOAuthUsage(token, signal)
      : unavailable('claude', 'missing-credentials', 'unavailable')
  }

  const root = await realpath(input.configRoot)
  let result: ProviderRateLimits | null
  if (input.provider === 'claude') {
    const selected = await claudeCredential(root, signal, Date.now(), claudeLoginOnly)
    if (!selected) {
      return unavailable('claude', 'missing-credentials', 'unavailable')
    }
    result = await fetchClaudeOAuthUsage(selected.token, signal)
    if (
      (await claudeCredential(root, signal, Date.now(), claudeLoginOnly))?.revision !==
      selected.revision
    ) {
      return unavailable('claude')
    }
  } else {
    const authPath = join(root, 'auth.json')
    const before = await credentialFile(authPath, signal)
    if (before === null) {
      return unavailable(input.provider, 'missing-credentials', 'unavailable')
    }
    const revision = fingerprint(root, before)
    result =
      input.provider === 'codex'
        ? await codexUsage(root, before, signal)
        : await fetchGrokRateLimits({ authReadResult: parseGrokAuthSession(before), signal })
    const after = await credentialFile(authPath, signal)
    if (after === null || fingerprint(root, after) !== revision) {
      return unavailable(input.provider)
    }
  }
  if (signal.aborted || (await realpath(input.configRoot)) !== root) {
    return unavailable(input.provider)
  }
  return result ?? unavailable(input.provider, 'usage-unavailable', 'unavailable')
}

export async function probeSelectedAccountUsage(
  input: SelectedAccountUsageRequest,
  options: { claudeLoginOnly?: boolean } = {}
): Promise<ProviderRateLimits> {
  const selected = { ...input }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ProviderRateLimits>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(unavailable(selected.provider, 'network'))
    }, PROBE_TIMEOUT_MS)
  })
  try {
    // Bound the whole operation too: filesystem and proxy preparation need not
    // observe an HTTP abort immediately. Late results never become receipts.
    const result = await Promise.race([
      probe(selected, controller.signal, options.claudeLoginOnly === true).catch(() =>
        unavailable(selected.provider)
      ),
      timeout
    ])
    return result.status === 'ok'
      ? result
      : unavailable(
          selected.provider,
          result.usageMetadata?.failureKind ?? 'usage-unavailable',
          result.status === 'unavailable' ? 'unavailable' : 'error'
        )
  } finally {
    clearTimeout(timer)
  }
}
