import type { AgentProviderSessionMetadata } from './agent-session-resume'
import type { AgentType, NativeChatMessage } from './native-chat-types'
import type { RuntimeTerminalRead, RuntimeTerminalState } from './runtime-types'
import type { PtyLivenessVerdict } from './pty-liveness-verdict'

export const ORCHESTRATION_WORKER_READ_SOURCES = ['auto', 'transcript', 'terminal'] as const
export type OrchestrationWorkerReadSource = (typeof ORCHESTRATION_WORKER_READ_SOURCES)[number]

export const ORCHESTRATION_WORKER_READ_FALLBACK_REASONS = [
  'provider_unsupported',
  'session_not_reported',
  'transcript_missing',
  'transcript_unreadable',
  'transcript_parse_failed',
  'remote_capability_unavailable'
] as const
export type OrchestrationWorkerReadFallbackReason =
  (typeof ORCHESTRATION_WORKER_READ_FALLBACK_REASONS)[number]

export type ExactWorkerProviderSession = {
  paneKey: string
  processIncarnation: string
  agent: AgentType
  providerSession: AgentProviderSessionMetadata
  observedAt: number
}

export type OrchestrationWorkerResumeManifest = {
  /** Coordinates on the execution owner; never credentials or authority to relaunch elsewhere. */
  execution?: {
    hostname: string
    profilePath: string
    hostScope: string
    worktreeId: string
    worktreePath: string
    accountChoiceId: string | null
    accountHome: string
  }
  agent: AgentType
  providerSessionKey: string
  providerSessionId: string
  transcriptPath: string | null
  processIncarnation: string
}

export type OrchestrationWorkerRouteObservation = {
  source: 'provider-transcript'
  model: string
  effort: string | null
  observedAt: number | null
}

export type OrchestrationWorkerTranscriptPage = {
  messages: NativeChatMessage[]
  nextCursor: string
  limited: boolean
  returnedMessageCount: number
}

export type OrchestrationWorkerReadTranscriptResult = {
  dispatchId: string
  source: 'transcript'
  sourceIdentity: string
  provider: AgentType
  transcript: OrchestrationWorkerTranscriptPage
  cursor: string
  status: {
    worker: string
    terminal: RuntimeTerminalState
    liveness?: PtyLivenessVerdict['status']
  }
  fallbackReason: null
  warnings: string[]
  routeObservation?: OrchestrationWorkerRouteObservation
  // The live PTY was released; output comes from the frozen archive source.
  archived?: boolean
  /** Provider identity retained on the execution host; no automatic resume is implied. */
  resume?: OrchestrationWorkerResumeManifest
}

export type OrchestrationWorkerReadTerminalResult = {
  dispatchId: string
  source: 'terminal'
  sourceIdentity: string
  terminal: RuntimeTerminalRead
  cursor: string | null
  status: {
    worker: string
    terminal: RuntimeTerminalState
    liveness?: PtyLivenessVerdict['status']
  }
  fallbackReason: OrchestrationWorkerReadFallbackReason | null
  warnings: string[]
  // The live PTY was released; output comes from the frozen archive source.
  archived?: boolean
  /** Provider identity retained on the execution host; no automatic resume is implied. */
  resume?: OrchestrationWorkerResumeManifest
}

export type OrchestrationWorkerReadResult =
  | OrchestrationWorkerReadTranscriptResult
  | OrchestrationWorkerReadTerminalResult
