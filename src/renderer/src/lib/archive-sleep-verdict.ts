import type { CleanupKeepReason } from '../../../shared/automatic-session-cleanup-protection'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type {
  ArchiveSleepHostReading,
  ArchiveSleepKeep,
  ArchiveSleepTrigger,
  ArchiveSleepVia
} from '../../../shared/archive-sleep-contract'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'
import { archiveSleepKeep, type ArchiveSleepTouch } from './archive-sleep-guards'
import { conversationViewKey } from './conversation-view'
import { livePtyIdForSessionPane } from './session-sleep-target'
import type { SidebarSession } from './sidebar-sessions'

/** Where a pane's worktree executes, as this window resolves it. */
export type ArchiveSleepHost = { executionHostId: string; runtimeEnvironmentId: string | null }

/**
 * `drop` forgets the pane (switched off, not local, not archived, nothing running); `wait` keeps
 * it armed (not idle yet, or a keep holds); `check-host` asks main for its own reading.
 */
export type ArchiveSleepVerdict =
  | { kind: 'drop' }
  | { kind: 'wait'; keep: ArchiveSleepKeep }
  | { kind: 'check-host'; status: AgentStatusEntry }

// Why a copy: provider done hooks can fire mid-dispatch; the same rule as
// agent-hibernation-pane-eligibility.ts, which this feature must not edit.
function hasUnsettledOrUnknownDispatch({ orchestration }: AgentStatusEntry): boolean {
  return orchestration
    ? !['completed', 'failed', 'circuit_broken'].includes(orchestration.dispatchStatus ?? '')
    : false
}

/**
 * restore-flood-guard owns `restoreFloodGuard` and its default (true, in every loaded profile).
 * Only an explicit true counts: without the guard a restart could resume what archive slept.
 */
function restoreFloodGuardOn(settings: object): boolean {
  return (settings as { restoreFloodGuard?: unknown }).restoreFloodGuard === true
}

export function isArchiveSleepSwitchedOff(state: Pick<AppState, 'settings'>): boolean {
  return (
    !state.settings ||
    state.settings.archiveSleepsIdleAgents === false ||
    !restoreFloodGuardOn(state.settings) ||
    Boolean(state.settings.activeRuntimeEnvironmentId?.trim())
  )
}

export function archiveSleepLivePtyId(
  state: AppState,
  tabId: string,
  paneKey: string
): string | null {
  const leafId = parsePaneKey(paneKey)?.leafId
  return leafId ? livePtyIdForSessionPane(state, tabId, leafId) : null
}

function isIdleDone(status: AgentStatusEntry): boolean {
  return (
    status.state === 'done' &&
    !status.interrupted &&
    !status.failed &&
    !status.workingMode &&
    !status.subagents?.length &&
    (status.backgroundTaskCount ?? 0) === 0 &&
    !hasUnsettledOrUnknownDispatch(status)
  )
}

export function archiveSleepVerdict(input: {
  state: AppState
  archived: readonly string[]
  session: SidebarSession
  host: ArchiveSleepHost
  touch: ArchiveSleepTouch
  protectionKeep: CleanupKeepReason | null
}): ArchiveSleepVerdict {
  const { state, session, host } = input
  if (
    isArchiveSleepSwitchedOff(state) ||
    session.kind !== 'terminal' ||
    !session.tabId ||
    !session.paneKey
  ) {
    return { kind: 'drop' }
  }
  // Why every reading: a session executed on another computer (SSH or a paired runtime) is
  // never stopped from here, however it is reached.
  if (
    parseExecutionHostId(session.hostId ?? 'local')?.kind !== 'local' ||
    host.executionHostId !== 'local' ||
    host.runtimeEnvironmentId
  ) {
    return { kind: 'drop' }
  }
  const status = state.agentStatusByPaneKey?.[session.paneKey]
  const ptyId = archiveSleepLivePtyId(state, session.tabId, session.paneKey)
  if (status?.connectionId || ptyId?.startsWith('remote:') || (!ptyId && !status)) {
    return { kind: 'drop' }
  }
  if (!input.archived.includes(conversationViewKey(session))) {
    return { kind: 'drop' }
  }
  // Why unknown waits: only a positive Done reading may stop an agent.
  if (!ptyId || !status || !isIdleDone(status) || session.launchPending || session.unavailable) {
    return { kind: 'wait', keep: 'not-idle' }
  }
  const keep = archiveSleepKeep({
    paneKey: session.paneKey,
    tabId: session.tabId,
    ptyId,
    status,
    record: state.sleepingAgentSessionsByPaneKey?.[session.paneKey],
    touch: input.touch
  })
  if (keep) {
    return { kind: 'wait', keep }
  }
  // Why: killing the PTY discards a draft or queued message typed into its composer.
  const inputAt = input.touch.inputAtByPaneKey[session.paneKey]
  if (typeof inputAt === 'number' && Number.isFinite(inputAt)) {
    if (lastInputBlocksHibernation(status, inputAt)) {
      return { kind: 'wait', keep: 'pending' }
    }
  }
  if (input.protectionKeep) {
    return { kind: 'wait', keep: input.protectionKeep }
  }
  return { kind: 'check-host', status }
}

export function archiveSleepEvidence(input: {
  trigger: ArchiveSleepTrigger
  via: ArchiveSleepVia
  doneSince: number
  armedAt: number
  reading: ArchiveSleepHostReading
}): string {
  const at = (ms: number): string =>
    Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : 'unknown'
  return [
    `${input.trigger}: Done since ${at(input.doneSince)}`,
    `archived via ${input.via} at ${at(input.armedAt)}`,
    'not on screen, untouched 10+ min, no open ask',
    `host: ${input.reading.state ?? 'idle'}`,
    'nothing queued, drafted, held, kept going, planned or awaited'
  ].join('; ')
}
