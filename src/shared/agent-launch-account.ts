import { deriveHostResourceView, type HostResourceReading } from './host-resource-model'
import type { CapacityProvider } from './provider-account-capacity'

// Wire contract for verified-account launches; gated on agent-session.verified-account-launch.v1.

export const AGENT_LAUNCH_READINESS_METHOD = 'terminal.agentLaunchReadiness' as const

export const AGENT_LAUNCH_REFUSAL_CODES = [
  'agent_session_account_unverified',
  'agent_session_routing_unavailable',
  'agent_session_runtime_changed',
  'agent_session_host_mismatch'
] as const

export type AgentLaunchRefusalCode = (typeof AGENT_LAUNCH_REFUSAL_CODES)[number]

export type AgentLaunchRefusal = Error & {
  code: AgentLaunchRefusalCode
  data?: Record<string, unknown>
}

/** A pre-spawn refusal whose code and data survive the RPC boundary (rpc/errors.ts passthrough). */
export function agentLaunchRefusal(
  code: AgentLaunchRefusalCode,
  message: string,
  data?: Record<string, unknown>
): AgentLaunchRefusal {
  return Object.assign(new Error(message), { code, ...(data ? { data } : {}) })
}

/** Paired runtimes execute their own workspaces, so to them those are `local`. */
export type AgentLaunchHostId = 'local' | `ssh:${string}`

export const AGENT_LAUNCH_RECEIPT_MAX_EXCLUDED = 8

export type AgentLaunchAccountReceipt = {
  policy: 'best-verified'
  hostId: AgentLaunchHostId
  provider: CapacityProvider
  /** Display path or email only; never a credential. */
  label: string
  /** Null on SSH: the relay picks from its own pool and reports no runtime choice id. */
  choiceId: string | null
  remainingPercent: number
  /** Null on SSH: the relay reports only the minimum window. */
  boundBy: 'five-hour' | 'weekly' | 'fable-weekly' | null
  readingAt: number
  readingAgeMs: number
  fableVerified: boolean
  verified: number | null
  considered: number | null
  excluded: { label: string; reason: string }[]
  why: string
}

export type AgentLaunchEffectiveModel = {
  model: string | null
  effort: string | null
  /** `account-config`: the account's own settings choose the model, which the runtime never sees. */
  source: 'request' | 'host-default' | 'account-config'
}

export type AgentLaunchAccountCandidate = {
  label: string
  state: string
  reason: string
  choiceId?: string
  until?: number
}

export type AgentLaunchReadinessParams = {
  worktree: string
  agent: CapacityProvider
  model?: string
  preview: boolean
  /** Placement (PR 2): also read the executing computer's load. Optional so PR 1 callers match. */
  load?: boolean
}

/** Offload-Before-Overload bands (host-resource-model.ts); `unknown` is never treated as `ok`. */
export type AgentLaunchLoadBand = 'ok' | 'offload' | 'hot' | 'unknown'

export type AgentLaunchLoad = {
  /** Optional measured RAM; absent on older hosts or when the reading is invalid. */
  freeBytes?: number
  totalBytes?: number
  loadPerCore: number
  band: AgentLaunchLoadBand
  /** Null when the host could not count them; never shown as zero. */
  liveSessions: number | null
  /** When the reading was taken, on the reading runtime's clock. */
  observedAt: number
}

/** Null unless the host answered with a timed reading: an unread host is unknown, not idle. */
export function agentLaunchLoadFromReading(
  reading: HostResourceReading | null | undefined,
  now: number
): AgentLaunchLoad | null {
  const view = deriveHostResourceView(reading, now)
  if (!view || reading?.readAt == null) {
    return null
  }
  return {
    ...(reading.memory &&
    Number.isFinite(reading.memory.totalMemory) &&
    reading.memory.totalMemory > 0 &&
    Number.isFinite(reading.memory.availableMemory) &&
    reading.memory.availableMemory >= 0 &&
    reading.memory.availableMemory <= reading.memory.totalMemory
      ? { freeBytes: view.freeBytes, totalBytes: view.totalBytes }
      : {}),
    loadPerCore: view.loadPerCore,
    band: view.band,
    liveSessions: view.liveSessions,
    observedAt: reading.readAt
  }
}

export type AgentLaunchReadinessWorkspace = {
  id: string
  hostId: AgentLaunchHostId
  kind: 'git' | 'folder'
  path: string
  name: string | null
}

export type AgentLaunchReadinessAccount =
  | { verified: true; receipt: AgentLaunchAccountReceipt }
  | { verified: false; refusal: string; accounts: AgentLaunchAccountCandidate[] }

export type AgentLaunchReadinessResult = {
  runtimeId: string
  workspace: AgentLaunchReadinessWorkspace
  /** Present only when `preview` was requested. */
  account?: AgentLaunchReadinessAccount
  /**
   * Placement (PR 2), Rule 1 optional: absent = the runtime never evaluated it (older build or
   * `load` not asked), null = asked but unread. Both read as unknown, never as idle.
   */
  load?: AgentLaunchLoad | null
  /**
   * One per machine and OS user, for placement dedupe: the runtime's `sessionHost.hostId` for
   * its own workspaces, the SSH host's hostStats `host.hostId` for `ssh:` ones. Null: unknown,
   * so the route is never merged with another.
   */
  machineId?: string | null
}
