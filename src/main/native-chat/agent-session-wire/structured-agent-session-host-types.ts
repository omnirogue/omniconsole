import type { LaunchCause } from '../../../shared/launch-cause'
import type { AgentSessionTaskSave } from '../../../shared/agent-session-wire'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionSpawnTokenScan } from '../../runtime/agent-session-spawn-token-process-scan'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionHandoffTransport } from './structured-agent-session-handoff-types'

export type StructuredAgentSessionCaller = {
  callerKey: string
  /** Host-derived provenance; never accepted from mutation parameters. */
  launchCause?: LaunchCause
  /** Derived from authenticated UI transport, never from agentSession.send params. */
  userSourceAuthority?: true
}

/** What the host believes about a session it just made addressable again. The workspace and agent
 *  come from the record, so a caller publishes the host's view rather than a client's assertion.
 *  `readable` is false when the journal could not be opened — the tab is still worth publishing,
 *  because attach recovers what read restore cannot. */
export type StructuredAgentSessionReveal = {
  sessionId: string
  workspaceId: string
  /** Widened from upstream's `'claude' | 'codex'`: this fork also routes ACP
   *  agents through the structured wire, and the value is taken straight off
   *  the record, so narrowing it here would refuse a chat the host can open. */
  agent: AgentSessionRecord['provider']
  readable: boolean
}

export type StructuredAgentSessionHostSession = {
  journal: AgentSessionJournal
  params: AgentSessionAttachParams
  fence: number
  /** Whether THIS host generation is running the provider process behind the session. A journal
   *  restored for reading has none, and neither has a session a TUI owns — so neither may be
   *  evicted to free a child, and neither may have its lease released as an observed exit. */
  hasProviderChild: boolean
  /** Exact adapter acquisition behind `hasProviderChild`; retained after exit to fence recovery. */
  acquisitionGeneration: string | null
}

export type NativeJournalObservation = {
  record: AgentSessionRecord
  cursor: AgentJournalCursor
  journal: AgentSessionJournal
  /** History restoration has no execution ownership; it may only project saved status. */
  readOnly?: boolean
  isCurrent(taskId: string): boolean
  onTaskSave?(status: AgentSessionTaskSave): void
}

export type NativeJournalPublicationCallbacks = {
  enabled(): boolean
  onReady(input: NativeJournalObservation): void
  onStopped?(input: NativeJournalObservation): Promise<void>
  onStarted(input: NativeJournalObservation): Promise<void>
  onCheckpoint(input: NativeJournalObservation): Promise<void>
}

export type StructuredAgentSessionHostDeps = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  journalRoot: string
  claimKeyId: string
  probeOwner?: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  probeOwners?: (
    records: readonly AgentSessionRecord[]
  ) => Promise<Map<string, AgentSessionOwnerProbe>>
  /** Recovery-exit stop requests only; a lease moves only on a later proven-absent probe. */
  stopOwnerProcess?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Host spawn-token process scan; null means the platform cannot enumerate, never "none". */
  scanSpawnTokenProcesses?: () => Promise<AgentSessionSpawnTokenScan | null>
  mintSpawnToken?: () => string
  resolveLaunchArgs?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<string[] | undefined> | string[] | undefined
  resolveLaunchEnv?: (
    provider: AgentSessionRecord['provider']
  ) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  resolveWorkspaceHubTaskId?: (
    workspaceId: string
  ) => Promise<string | undefined> | string | undefined
  now?: () => number
  persistTuiProviderHandle?: (input: {
    sessionId: string
    link: AgentSessionProviderHandleLink
    now: number
  }) => Promise<void>
  /** How long a session outlives its last surface. Tests drive this; production takes the default. */
  releaseGraceMs?: number
  onEventSinkError?: (input: { sessionId: string; error: unknown }) => void
  onJournalCheckpoint?: (input: NativeJournalObservation) => void | Promise<void>
  onSessionStopped?: (input: NativeJournalObservation) => void | Promise<void>
  onSessionStarted?: (input: NativeJournalObservation) => void | Promise<void>
  onJournalReady?: (input: NativeJournalObservation) => void
  handoffTransport?: StructuredAgentSessionHandoffTransport
}
