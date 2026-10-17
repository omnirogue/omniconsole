import type { RoomAccountStatus, RoomErrorCode } from './rooms'
import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent'

export type OmniRogueAccountState = Omit<RoomAccountStatus, 'state'> & {
  state: RoomAccountStatus['state'] | 'connected' | 'connecting' | 'error' | 'disconnected'
  connected?: boolean
  accountId?: string
  userId?: string
  email?: string | null
  orgName?: string | null
  pendingSince?: number | null
  lastError?: string | null
  displayName?: string
  avatarUrl?: string
  planTier?: string
  unifiedMcpLinked?: boolean
  balanceCredits?: number | null
  omnisiLinked?: boolean
  apiOrigin?: string
  frontendOrigin?: string
}

export type OmniRogueAccountErrorCode = RoomErrorCode | 'unauthenticated' | 'invalid_request'

export type PrimaryAiBillingMode = 'own-login' | 'omnirogue-credits'
export type OmniRogueBillingMode = PrimaryAiBillingMode

export type PrimaryAiPreference = {
  agent: TuiAgent
  model?: string
  billing: PrimaryAiBillingMode
}

export type OmniRogueCreditBalance = {
  availableCredits: number
  reservedCredits?: number
  totalCredits?: number
  plan?: string
  currency?: string
  lowBalanceThreshold?: number
  updatedAt: string
}

export type DiscoverCreditMode = 'quick' | 'standard' | 'deep'

export type DiscoverCreditBudgetGuard = {
  allowed: boolean
  shortfallCredits: number
  warningMessage: string | null
  recommendedAction: 'proceed' | 'top-up' | 'switch-to-quick' | 'connect-account'
}

export type DiscoverCreditQuote = {
  mode: DiscoverCreditMode
  estimatedCredits: number
  maxReservationCredits: number
  quickMaxReservationCredits: number
  agentCalls: { low: number; high: number }
  balance: OmniRogueCreditBalance | null
  balanceStatus: 'not-requested' | 'available' | 'connect-account' | 'unavailable'
}

export const OMNIROGUE_GATEWAY_DEFAULT_BASE_URL = 'https://api.omnirogue.com'

export type OmniRogueGatewayProvider = 'anthropic' | 'openai' | 'google'

export type OmniRogueGatewayModelId = string

export type OmniRogueGatewayModelOption = {
  id: OmniRogueGatewayModelId
  label: string
  provider: OmniRogueGatewayProvider
  recommendedAgents: readonly TuiAgent[]
  defaultAgent?: TuiAgent
  supportsSlashModel?: boolean
  description?: string
}

export const FALLBACK_GATEWAY_MODELS: readonly OmniRogueGatewayModelOption[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    provider: 'anthropic',
    recommendedAgents: ['claude', 'opencode']
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    recommendedAgents: ['claude', 'opencode']
  },
  {
    id: 'claude-haiku-5-5',
    label: 'Claude Haiku 5.5',
    provider: 'anthropic',
    recommendedAgents: ['claude', 'opencode']
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    provider: 'openai',
    recommendedAgents: ['codex', 'opencode']
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    provider: 'openai',
    recommendedAgents: ['codex', 'opencode']
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    provider: 'google',
    recommendedAgents: ['gemini', 'opencode']
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    provider: 'google',
    recommendedAgents: ['gemini', 'opencode']
  }
] as const

export const OMNIROGUE_GATEWAY_MODELS = FALLBACK_GATEWAY_MODELS

export type OmniRogueGatewaySession = {
  active: boolean
  billing?: PrimaryAiBillingMode
  baseUrl?: string
  openAiBaseUrl?: string
  agent?: TuiAgent
  model?: string
  expiresAt?: number
  tokenAvailable?: boolean
  availableModels?: readonly OmniRogueGatewayModelOption[]
  switchedInSession?: boolean
  requiresRestartForBillingChange?: boolean
}

export function isOmniRogueObpToken(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }
  const trimmed = value.trim()
  return trimmed.startsWith('or_obp_') && trimmed.length > 'or_obp_'.length
}

export function isPrimaryAiBillingMode(value: unknown): value is PrimaryAiBillingMode {
  return value === 'own-login' || value === 'omnirogue-credits'
}

export function normalizePrimaryAiPreference(value: unknown): PrimaryAiPreference | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (!isTuiAgent(candidate.agent) || !isPrimaryAiBillingMode(candidate.billing)) {
    return undefined
  }
  const rawModel = typeof candidate.model === 'string' ? candidate.model.trim() : ''
  return {
    agent: candidate.agent,
    ...(rawModel ? { model: rawModel } : {}),
    billing: candidate.billing
  }
}
