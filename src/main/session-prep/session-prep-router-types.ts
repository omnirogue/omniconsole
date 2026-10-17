import type { CommitMessageAiModelCapability } from '../../shared/commit-message-ai-types'
import type { SessionPrepEffort } from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'

export type SessionPrepRoutingMode = 'off' | 'shadow' | 'live'

/** Listings belong to the execution host. A seed is never evidence of availability. */
export type SessionPrepRouterCatalog = {
  hostId: string
  observedAt: number
  agents: {
    provider: TuiAgent
    models: CommitMessageAiModelCapability[]
    discovered: boolean
    error?: string
  }[]
}

export type SessionPrepRouterRequest = {
  brief: string
  title: string
  provider?: TuiAgent
  model?: string
  effort?: SessionPrepEffort
  mode?: SessionPrepRoutingMode
  enabledProviders?: TuiAgent[]
  executionTarget?: {
    path: string
    connectionId?: string
    hostId?: string
    repoId?: string
    isFolder?: boolean
  }
  catalog?: SessionPrepRouterCatalog
}

export type SessionPrepRouterCandidate = {
  family: string
  available: boolean
  reason: string
  provider?: TuiAgent
  model?: string
}

export type SessionPrepRouterMetadata = {
  mode?: SessionPrepRoutingMode
  elapsedMs?: number
  version?: string
  origin?: 'override' | 'estate' | 'bundled'
  /** CLI listings advertise availability; only a worker receipt can attest the served model. */
  modelEvidence?: 'advertised' | 'estate-policy'
  requested?: { provider?: TuiAgent; model?: string; effort?: SessionPrepEffort }
  candidates?: SessionPrepRouterCandidate[]
  selectionBasis?: string
}

export type SessionPrepRouterDecision = SessionPrepRouterMetadata & {
  provider: TuiAgent
  model: string
  effort?: SessionPrepEffort
  tier: string
  gate: string
  reason: string
  note: string
}

export type SessionPrepRouterUnavailable = SessionPrepRouterMetadata & {
  unrouted: string
  status: 'off' | 'unavailable' | 'pinned'
  /** Hold an impossible explicit choice or a missing required capability instead of substituting. */
  blocking?: boolean
}

export type SessionPrepRouterResult = SessionPrepRouterDecision | SessionPrepRouterUnavailable
