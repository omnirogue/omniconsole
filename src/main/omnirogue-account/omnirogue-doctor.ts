import type { OmniRogueAccountState, PrimaryAiBillingMode } from '../../shared/omnirogue-account'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import { listMcpTools } from './omnirogue-mcp-tools-list'
export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skipped'
export type DoctorAction = 'reconnect' | 'top-up' | 'retry'
export type OmniRogueDoctorCheck = {
  id: string
  label: string
  status: DoctorStatus
  latencyMs: number
  message: string
  remediation?: DoctorAction
  checks?: OmniRogueDoctorCheck[]
}
export type OmniRogueDoctorResult = {
  checkedAt: string
  billingMode: PrimaryAiBillingMode
  status: DoctorStatus
  stages: OmniRogueDoctorCheck[]
}
export type OmniRogueDoctorOptions = {
  account: { status(): Promise<OmniRogueAccountState>; leaseToken(): Promise<string | null> }
  billingMode: PrimaryAiBillingMode
  fetcher?: typeof fetch
  timeoutMs?: number
  minTokenHeadroomMs?: number
  now?: () => number
}
const API = 'https://api.omnirogue.com'
const MCP_ENDPOINTS = ['https://app.omnisi.ai/mcp', `${API}/mcp`]
const MODELS = ['claude-opus-5-5', 'gpt-6-astra', 'gemini-4-argon']
const NAMESPACES = ['credits.', 'media.', 'si.', 'tools_search']
const LABELS: Record<string, string> = {
  account: 'Account Link & Token Lease',
  wallet: 'Unified Credit Wallet',
  mcp: 'Unified MCP',
  gateway: 'Multi-Model LLM Gateway'
}
const MAX_BYTES = 2 * 1024 * 1024
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
class DoctorFailure extends Error {
  constructor(
    message: string,
    readonly remediation: DoctorAction = 'retry'
  ) {
    super(message)
  }
}
function assertResponse(value: unknown): asserts value {
  if (!value) {
    throw new DoctorFailure('The service returned an invalid response.')
  }
}
const summary = (status: DoctorStatus, message: string, remediation?: DoctorAction) => ({
  status,
  message,
  ...(remediation ? { remediation } : {})
})
const aggregate = (checks: OmniRogueDoctorCheck[]): DoctorStatus =>
  (['fail', 'warn'] as const).find((status) => checks.some((check) => check.status === status)) ??
  'pass'
/** Read-only probes; the caller supplies the lease belonging to the execution host. */
export async function runOmniRogueDoctor(
  options: OmniRogueDoctorOptions
): Promise<OmniRogueDoctorResult> {
  const fetcher = options.fetcher ?? fetch,
    now = options.now ?? Date.now
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs || 10_000, 60_000))
  let token: string | null = null
  let connected = false
  async function check(
    id: string,
    work: (signal: AbortSignal) => Promise<Omit<OmniRogueDoctorCheck, 'id' | 'label' | 'latencyMs'>>
  ): Promise<OmniRogueDoctorCheck> {
    const base = { id, label: LABELS[id] ?? id, latencyMs: 0 }
    if (id !== 'account' && !connected) {
      return { ...base, ...summary('skipped', 'Connect a healthy account first.') }
    }
    const started = performance.now(),
      controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new DoctorFailure('Check timed out.'))
      }, timeoutMs)
    })
    let result: Omit<OmniRogueDoctorCheck, 'id' | 'label' | 'latencyMs'>
    try {
      result = await Promise.race([work(controller.signal), timeout])
    } catch (error) {
      const failure =
        error instanceof DoctorFailure
          ? error
          : new DoctorFailure('Unable to complete the check. Retry when connected.')
      result = summary('fail', failure.message, failure.remediation)
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
    return { ...base, ...result, latencyMs: Math.round(performance.now() - started) }
  }
  async function request(
    url: string,
    signal: AbortSignal,
    body?: unknown,
    headers?: Record<string, string>
  ) {
    signal.throwIfAborted()
    const response = await fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      void response.body?.cancel().catch(() => undefined)
      if (response.status === 401 || response.status === 403) {
        throw new DoctorFailure('Account access was rejected. Reconnect your account.', 'reconnect')
      }
      throw new DoctorFailure(`Service request failed (HTTP ${response.status}).`)
    }
    return response
  }
  async function json(url: string, signal: AbortSignal) {
    const response = await request(url, signal)
    const value = record(await readFetchResponseJsonWithinLimit(response, MAX_BYTES))
    assertResponse(Object.keys(value).length && !value.error && value.success !== false)
    return value
  }
  const account = await check('account', async (signal) => {
    const state = await options.account.status()
    signal.throwIfAborted()
    if (state.state !== 'linked' || (state.apiOrigin && state.apiOrigin !== API)) {
      throw new DoctorFailure('Link an account for the OmniRogue production service.', 'reconnect')
    }
    const leased = await options.account.leaseToken()
    signal.throwIfAborted()
    if (!leased || !/^or_obp_[A-Za-z0-9_-]{43}$/.test(leased)) {
      throw new DoctorFailure('A valid account token is unavailable.', 'reconnect')
    }
    const headroom = typeof state.expiresAt === 'number' ? state.expiresAt - now() : Number.NaN
    if (headroom <= 0) {
      throw new DoctorFailure('The account token has expired.', 'reconnect')
    }
    token = leased
    await json(`${API}/api/omniconsole/device/me`, signal)
    if (!Number.isFinite(headroom)) {
      return summary('warn', 'Token expiry could not be verified.', 'reconnect')
    }
    return headroom < (options.minTokenHeadroomMs ?? 300_000)
      ? summary('warn', 'The account token expires soon.', 'reconnect')
      : summary('pass', 'Account reachable; token has sufficient expiry headroom.')
  })
  connected = account.status !== 'fail'
  const wallet = await check('wallet', async (signal) => {
    const payload = await json(`${API}/api/omniconsole/wallet`, signal)
    const wallet = record(payload.wallet ?? payload.data ?? payload)
    const credits = wallet.spendableCredits ?? wallet.spendable_credits ?? wallet.availableCredits
    assertResponse(typeof credits === 'number' && Number.isFinite(credits) && credits >= 0)
    return credits === 0
      ? summary('warn', 'No spendable credits remain.', 'top-up')
      : summary('pass', `${credits} spendable credits available.`)
  })
  async function mcp(url: string): Promise<OmniRogueDoctorCheck> {
    return check(url, async (signal) => {
      const tools = await listMcpTools(
        (body, headers) => request(url, signal, body, headers),
        'omnirogue-doctor',
        () => new DoctorFailure('The service returned an invalid response.')
      )
      const names = new Set(tools.map((tool) => String(tool.name)))
      const missing = NAMESPACES.filter((namespace) =>
        namespace === 'tools_search'
          ? !names.has(namespace)
          : ![...names].some((name) => name.startsWith(namespace) && name.length > namespace.length)
      )
      return missing.length
        ? summary('fail', `Missing tools: ${missing.join(', ')}.`, 'retry')
        : summary('pass', 'Unified credit, media, SI and search tools are available.')
    })
  }
  const checks = connected ? await Promise.all(MCP_ENDPOINTS.map(mcp)) : []
  const unified = await check('mcp', async () => ({
    checks,
    ...summary(aggregate(checks), 'See the results for each MCP endpoint.')
  }))
  unified.latencyMs = Math.max(0, ...checks.map((item) => item.latencyMs))
  const gateway = await check('gateway', async (signal) => {
    if (options.billingMode !== 'omnirogue-credits') {
      return summary('skipped', 'Gateway check applies to OmniRogue credits billing.')
    }
    const catalog = await json(`${API}/v1/models`, signal)
    assertResponse(Array.isArray(catalog.data))
    assertResponse(catalog.data.every((model) => typeof record(model).id === 'string'))
    const ids = new Set(catalog.data.map((model) => record(model).id))
    const missing = MODELS.filter((model) => !ids.has(model))
    return missing.length
      ? summary('fail', `Missing frontier models: ${missing.join(', ')}.`, 'retry')
      : summary('pass', 'Opus 5.5, GPT-6 Astra and Gemini 4 Argon are listed.')
  })
  const stages = [account, wallet, unified, gateway]
  const checkedAt = new Date(now()).toISOString(),
    billingMode = options.billingMode
  return { checkedAt, billingMode, status: aggregate(stages), stages }
}
