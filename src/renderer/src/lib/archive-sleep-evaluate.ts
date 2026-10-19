import type { readAutomaticCleanupProtection } from './automatic-session-cleanup-protection'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type {
  ArchiveSleepHostReading,
  ArchiveSleepNoteParams,
  ArchiveSleepTrigger,
  ArchiveSleepVia
} from '../../../shared/archive-sleep-contract'
import { archiveSleepIdleDueAt, type ArchiveSleepTouch } from './archive-sleep-guards'
import {
  archiveSleepEvidence,
  archiveSleepLivePtyId,
  archiveSleepVerdict,
  type ArchiveSleepHost,
  type ArchiveSleepVerdict
} from './archive-sleep-verdict'
import { conversationViewKey } from './conversation-view'
import type { SessionSleepResult } from './put-session-to-sleep'
import type { SidebarSession } from './sidebar-sessions'

export type ArchiveSleepDeps = {
  readProtection: typeof readAutomaticCleanupProtection
  app: () => AppState
  view: () => { loaded: boolean; archived: readonly string[] }
  panes: (state: AppState) => SidebarSession[]
  host: (state: AppState, worktreeId: string) => ArchiveSleepHost
  now: () => number
  touch: (state: AppState, now: number) => ArchiveSleepTouch
  /** main's reading (`sessionOrganization.archiveSleepReading`). */
  readHost: (session: SidebarSession) => Promise<ArchiveSleepHostReading>
  sleep: (session: SidebarSession) => Promise<SessionSleepResult>
  audit: (note: ArchiveSleepNoteParams) => Promise<void>
  subscribeApp: (listener: () => void) => () => void
  setTimer: (run: () => void, ms: number) => () => void
}

/** One archived local pane the controller holds armed. */
export type ArchiveSleepPending = {
  paneKey: string
  worktreeId: string
  tabId: string
  via: ArchiveSleepVia
  /** A person archived it: it sleeps as soon as it reads idle, now or when it finishes. */
  person: boolean
  armedAt: number
  cancelTimer: (() => void) | null
  lastState: AgentStatusEntry['state'] | null
  lastStateStartedAt: number | null
}

export type ArchiveSleepJudged = {
  session: SidebarSession
  status?: AgentStatusEntry
  /** The pane's live PTY, whose driver seat G2 reads. */
  ptyId: string | null
  verdict: ArchiveSleepVerdict
  touch: ArchiveSleepTouch
}

/** Every keep, read fresh from the store and the window's touch readings. */
export function judgeArchivedPane(
  deps: ArchiveSleepDeps,
  paneKey: string
): ArchiveSleepJudged | null {
  const state = deps.app()
  const session = deps.panes(state).find((row) => row.paneKey === paneKey)
  if (!session) {
    return null
  }
  const touch = deps.touch(state, deps.now())
  return {
    session,
    status: state.agentStatusByPaneKey?.[paneKey],
    ptyId: session.tabId ? archiveSleepLivePtyId(state, session.tabId, paneKey) : null,
    touch,
    verdict: archiveSleepVerdict({
      state,
      archived: deps.view().archived,
      session,
      host: deps.host(state, session.worktreeId),
      touch,
      protectionKeep:
        session.tabId && session.paneKey
          ? deps.readProtection(
              state,
              { worktreeId: session.worktreeId, tabId: session.tabId, paneKey: session.paneKey },
              touch.now,
              { ignoreStartedToday: true }
            )
          : 'protection-unknown'
    })
  }
}

export type ArchiveSleepEvaluation = {
  deps: ArchiveSleepDeps
  current: (paneKey: string) => ArchiveSleepPending | undefined
  forget: (paneKey: string) => void
  /** A timer's check that found a keep checks again one full period later. */
  retry: (entry: ArchiveSleepPending, trigger: ArchiveSleepTrigger) => void
  disposed: () => boolean
}

/** The pane `archiveSleepIdleDueAt` reads: the armed entry's tab and pane, the judged PTY. */
export function paneOf(
  entry: ArchiveSleepPending,
  judged: Pick<ArchiveSleepJudged, 'ptyId'>
): { tabId: string; paneKey: string; ptyId: string | null } {
  return { tabId: entry.tabId, paneKey: entry.paneKey, ptyId: judged.ptyId }
}

function idleEnough(
  entry: ArchiveSleepPending,
  judged: ArchiveSleepJudged,
  trigger: ArchiveSleepTrigger
): boolean {
  return (
    trigger !== 'idle-timer' ||
    archiveSleepIdleDueAt(entry.armedAt, judged.status, paneOf(entry, judged), judged.touch) <=
      judged.touch.now
  )
}

/**
 * One check of one armed pane: every local keep, then main's reading, then every keep again
 * immediately before the sleep (G4). Anything unread keeps the agent.
 */
export async function evaluateArchivedPane(
  ctx: ArchiveSleepEvaluation,
  paneKey: string,
  trigger: ArchiveSleepTrigger
): Promise<void> {
  const { deps } = ctx
  const entry = ctx.current(paneKey)
  const first = entry && !ctx.disposed() ? judgeArchivedPane(deps, paneKey) : null
  if (!entry || !first || first.verdict.kind === 'drop') {
    ctx.forget(paneKey)
    return
  }
  if (first.verdict.kind !== 'check-host' || !idleEnough(entry, first, trigger)) {
    ctx.retry(entry, trigger)
    return
  }
  const segment = first.verdict.status.stateStartedAt
  let reading: ArchiveSleepHostReading = { clear: false, keep: 'unreadable' }
  try {
    reading = await deps.readHost(first.session)
  } catch {
    // Why: an unreadable or older host is never evidence that nothing is pending.
  }
  if (reading.clear !== true || ctx.disposed() || ctx.current(paneKey) !== entry) {
    ctx.retry(entry, trigger)
    return
  }
  // G4: the host read awaited; re-check every keep immediately before acting.
  const second = judgeArchivedPane(deps, paneKey)
  if (!second || second.verdict.kind === 'drop') {
    ctx.forget(paneKey)
    return
  }
  if (
    second.verdict.kind !== 'check-host' ||
    second.verdict.status.stateStartedAt !== segment ||
    !idleEnough(entry, second, trigger)
  ) {
    ctx.retry(entry, trigger)
    return
  }
  const result = await deps.sleep(second.session)
  if (!result.ok) {
    // Why keep: a refusal (not resumable yet, a phone driving it) may clear later.
    ctx.retry(entry, trigger)
    return
  }
  ctx.forget(paneKey)
  try {
    await deps.audit({
      sessionKey: conversationViewKey(second.session),
      paneKey,
      tabId: second.session.tabId ?? entry.tabId,
      title: (second.session.customTitle ?? second.session.label).slice(0, 200),
      via: entry.via,
      trigger,
      evidence: archiveSleepEvidence({
        trigger,
        via: entry.via,
        doneSince: segment,
        armedAt: entry.armedAt,
        reading
      })
    })
  } catch (error) {
    // Why only a warning: the agent is already asleep and resumable; the record is secondary.
    console.warn('[archive-sleeps-idle-agents] History line not written', error)
  }
}
