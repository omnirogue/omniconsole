import {
  isOmniRogueObpToken,
  isPrimaryAiBillingMode,
  OMNIROGUE_GATEWAY_DEFAULT_BASE_URL,
  type PrimaryAiBillingMode
} from '../../shared/omnirogue-account'
import type { TuiAgent } from '../../shared/tui-agent'
import { addWslEnvKeys } from '../../shared/wsl-env'

export type OmniRogueGatewayEnvInput = {
  env: NodeJS.ProcessEnv
  cwd?: string
  launchAgent?: TuiAgent
  isWsl?: boolean
  wslDistro?: string | null
  userDataPath?: string
  billing?: PrimaryAiBillingMode
  platform?: NodeJS.Platform
  token?: string | null
  baseUrl?: string
  model?: string
}

export type OmniRogueGatewayRuntimeState = {
  billing: PrimaryAiBillingMode
  agent?: TuiAgent
  model?: string
  token?: string | null
  baseUrl?: string
  expiresAt?: number
}

let runtimeState: OmniRogueGatewayRuntimeState = {
  billing: 'own-login',
  token: null
}

/** Matches RoomCredentialStore.leaseAccess: a token this close to expiry is re-leased first. */
export const OMNIROGUE_GATEWAY_REFRESH_SKEW_MS = 5 * 60_000
const REFRESH_WAIT_MS = 10_000
const MAX_REPLACED_TOKENS = 16
// Tokens a refresh replaced; launch envs inherited from process.env can still carry them.
const replacedTokens = new Set<string>()
let tokenRefresher: (() => Promise<void>) | undefined
let refreshing: Promise<void> | undefined

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

export function resolveOmniRogueGatewayBaseUrl(
  overrideUrl?: string | null,
  env?: NodeJS.ProcessEnv
): string {
  const candidate =
    overrideUrl?.trim() ||
    env?.OMNIROGUE_GATEWAY_BASE_URL?.trim() ||
    runtimeState.baseUrl?.trim() ||
    process.env.OMNIROGUE_GATEWAY_BASE_URL?.trim() ||
    OMNIROGUE_GATEWAY_DEFAULT_BASE_URL
  return stripTrailingSlashes(candidate) || OMNIROGUE_GATEWAY_DEFAULT_BASE_URL
}

export function resolveOmniRogueOpenAiBaseUrl(baseUrl: string): string {
  const normalized = stripTrailingSlashes(baseUrl)
  return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`
}

function envValue(
  env: NodeJS.ProcessEnv | undefined,
  key: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') {
    return env?.[key]
  }
  return Object.entries(env ?? {}).find(([name]) => name.toUpperCase() === key)?.[1]
}

export function resolveOmniRogueGatewayBillingMode(
  billing?: PrimaryAiBillingMode,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): PrimaryAiBillingMode {
  if (billing) {
    return billing
  }
  for (const source of [env, process.env]) {
    for (const key of ['OMNIROGUE_BILLING_MODE', 'ORCA_OMNIROGUE_BILLING_MODE']) {
      const value = envValue(source, key, platform)
      if (isPrimaryAiBillingMode(value)) {
        return value
      }
    }
  }
  return runtimeState.billing
}

export function resolveOmniRogueGatewayToken(
  overrideToken?: string | null,
  env?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string | null {
  const candidates = [
    overrideToken,
    envValue(env, 'ORCA_OMNIROGUE_GATEWAY_TOKEN', platform),
    envValue(env, 'OMNIROGUE_GATEWAY_TOKEN', platform),
    envValue(env, 'OMNIROGUE_OBP_TOKEN', platform),
    runtimeState.token,
    envValue(env, 'ANTHROPIC_AUTH_TOKEN', platform),
    process.env.ORCA_OMNIROGUE_GATEWAY_TOKEN,
    process.env.OMNIROGUE_GATEWAY_TOKEN,
    process.env.OMNIROGUE_OBP_TOKEN
  ]
  const superseded = runtimeState.token ? replacedTokens : undefined
  for (const [index, candidate] of candidates.entries()) {
    // An explicit override always wins; inherited copies of a replaced token never do.
    if (isOmniRogueObpToken(candidate) && (index === 0 || !superseded?.has(candidate.trim()))) {
      return candidate.trim()
    }
  }
  return null
}

export function syncOmniRogueGatewayRuntimeState(
  next: Partial<OmniRogueGatewayRuntimeState>
): OmniRogueGatewayRuntimeState {
  const previous = runtimeState.token
  if (previous && next.token && next.token !== previous) {
    replacedTokens.add(previous)
    if (replacedTokens.size > MAX_REPLACED_TOKENS) {
      replacedTokens.delete(replacedTokens.values().next().value!)
    }
  }
  if (next.token) {
    replacedTokens.delete(next.token)
  }
  runtimeState = {
    ...runtimeState,
    ...next,
    billing: isPrimaryAiBillingMode(next.billing) ? next.billing : runtimeState.billing
  }
  return { ...runtimeState }
}

/** Main installs the account lease's refresh; the relay and tests run without one. */
export function setOmniRogueGatewayTokenRefresher(
  refresh: (() => Promise<void>) | undefined
): void {
  tokenRefresher = refresh
}

/**
 * Re-leases the cached gateway token before a launch reads it when it is within the refresh skew
 * of expiry. Bounded, so a slow refresh never holds a launch; the cached token is used then.
 */
export async function ensureOmniRogueGatewayTokenFresh(now = Date.now()): Promise<void> {
  const { billing, token, expiresAt } = runtimeState
  if (
    !tokenRefresher ||
    billing !== 'omnirogue-credits' ||
    !token ||
    expiresAt === undefined ||
    expiresAt - OMNIROGUE_GATEWAY_REFRESH_SKEW_MS > now
  ) {
    return
  }
  refreshing ??= tokenRefresher()
    .catch(() => undefined)
    .finally(() => {
      refreshing = undefined
    })
  const task = refreshing
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    task,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REFRESH_WAIT_MS)
    })
  ])
  clearTimeout(timer)
}

export function getOmniRogueGatewayRuntimeState(): OmniRogueGatewayRuntimeState {
  return { ...runtimeState }
}

export function isOmniRogueGatewayEnvActive(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined
): boolean {
  if (!env) {
    return false
  }
  if (
    env.ORCA_OMNIROGUE_GATEWAY_ACTIVE === '1' ||
    env.ORCA_OMNIROGUE_BILLING_MODE === 'omnirogue-credits' ||
    env.OMNIROGUE_BILLING_MODE === 'omnirogue-credits'
  ) {
    return true
  }
  return (
    isOmniRogueObpToken(env.ANTHROPIC_AUTH_TOKEN) ||
    isOmniRogueObpToken(env.ANTHROPIC_API_KEY) ||
    isOmniRogueObpToken(env.OPENAI_API_KEY)
  )
}

/**
 * Electron-free gateway environment injector: populates Anthropic and OpenAI-compatible
 * gateway variables when a session launches in `omnirogue-credits` billing mode with a
 * valid leased `or_obp_` token.
 *
 * IMPORTANT: Do not import `electron` here — `omni-runtime.ts` and `orcad/main.ts`
 * transitively import `ipc/pty`.
 */
export function applyOmniRogueGatewayEnv(input: OmniRogueGatewayEnvInput): void {
  const effectiveBilling = resolveOmniRogueGatewayBillingMode(
    input.billing,
    input.env,
    input.platform
  )
  if (effectiveBilling !== 'omnirogue-credits') {
    return
  }

  const token = resolveOmniRogueGatewayToken(input.token, input.env, input.platform)
  if (!token) {
    return
  }

  const baseUrl = resolveOmniRogueGatewayBaseUrl(input.baseUrl, input.env)
  const openAiBaseUrl = resolveOmniRogueOpenAiBaseUrl(baseUrl)
  const effectiveModel = (
    input.model ??
    input.env.OMNIROGUE_MODEL ??
    runtimeState.model ??
    process.env.OMNIROGUE_MODEL
  )?.trim()

  const { env, launchAgent } = input
  env.OMNIROGUE_BILLING_MODE = 'omnirogue-credits'
  env.ORCA_OMNIROGUE_GATEWAY_ACTIVE = '1'
  env.ORCA_OMNIROGUE_BILLING_MODE = 'omnirogue-credits'
  env.OMNIROGUE_GATEWAY_BASE_URL = baseUrl

  const wslKeys: string[] = [
    'OMNIROGUE_BILLING_MODE',
    'ORCA_OMNIROGUE_GATEWAY_ACTIVE',
    'ORCA_OMNIROGUE_BILLING_MODE',
    'OMNIROGUE_GATEWAY_BASE_URL'
  ]

  if (effectiveModel) {
    env.OMNIROGUE_MODEL = effectiveModel
    wslKeys.push('OMNIROGUE_MODEL')
  }

  const injectAnthropic = launchAgent === 'claude' || launchAgent === undefined
  const injectOpenAi =
    launchAgent === 'codex' ||
    launchAgent === 'opencode' ||
    launchAgent === undefined ||
    (launchAgent !== 'claude' && launchAgent !== 'gemini')

  if (injectAnthropic) {
    if ((input.platform ?? process.platform) === 'win32') {
      const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
      for (const key of Object.keys(env)) {
        if (key !== key.toUpperCase() && keys.includes(key.toUpperCase())) {
          delete env[key]
        }
      }
    }
    env.ANTHROPIC_BASE_URL = baseUrl
    env.ANTHROPIC_AUTH_TOKEN = token
    env.ANTHROPIC_API_KEY = token
    wslKeys.push('ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY')
  }

  if (injectOpenAi) {
    env.OPENAI_BASE_URL = openAiBaseUrl
    env.OPENAI_API_KEY = token
    wslKeys.push('OPENAI_BASE_URL', 'OPENAI_API_KEY')
  }

  if (input.isWsl) {
    addWslEnvKeys(env as Record<string, string>, wslKeys)
  }
}
