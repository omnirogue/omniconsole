import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  getForegroundTerminalTabLastSeenAtById,
  getForegroundTerminalTabRevealedAt
} from './foreground-terminal-tabs'
import {
  classifyGuardedResume,
  getPersonRevealedAt,
  hasLiveInteractiveAsk,
  isRestoreFloodGuardOn,
  resolveResumeKeepReason,
  type GuardedResumeKind,
  type ResumeKeepReason
} from './restore-flood-guard'

// Why a registry: the put-away check reads the sidebar's personal view (isPutAwayPaneKey); the
// terminal connect path must not import the sidebar model. The interrupted-restore installer,
// which owns that check, registers it at app start.
let putAwayPaneReader: ((paneKey: string) => boolean) | null = null

export function setPutAwayPaneReader(reader: (paneKey: string) => boolean): () => void {
  putAwayPaneReader = reader
  return () => {
    if (putAwayPaneReader === reader) {
      putAwayPaneReader = null
    }
  }
}

/** Archived, hidden or deleted in the sidebar, as the interrupted-restore installer reads it;
 *  false until that installer registered its reader (the personal view is unread). */
export function isPaneKeyPutAway(paneKey: string): boolean {
  try {
    return putAwayPaneReader?.(paneKey) === true
  } catch {
    return false
  }
}

type VerdictState = {
  settings: Pick<GlobalSettings, 'restoreFloodGuard'> | null
  lastTerminalInputAtByPaneKey?: Readonly<Record<string, number | undefined>>
}

export type BackgroundResumeVerdict =
  | { hold: false; reason: ResumeKeepReason | 'not-guarded' | 'guard-off' }
  | { hold: true; kind: GuardedResumeKind }

export type BackgroundResumeTarget = {
  paneKey: string
  tabId: string
  /** The sleeping record the resume would consume; null when a live status row drives it. */
  record: SleepingAgentSessionRecord | null
  entry?: Pick<AgentStatusEntry, 'state' | 'interactivePrompt' | 'restoredUnconfirmed'> | null
  liveEntryWorking?: boolean
  /** A live status row drives the resume, whatever its state (`record` is null then). */
  liveEntryDriven?: boolean
  deferredStartup?: boolean
  /** G3: the pane's isVisibleRef — the same live predicate pty-exit-hibernate uses. */
  visible: boolean
}

/**
 * Whether resuming this pane's agent must wait for a person (hold: no PTY at all). Evaluated
 * immediately before each individual resume (G4): a hold is never cached across actions.
 */
export function decideBackgroundResume(
  state: VerdictState,
  target: BackgroundResumeTarget,
  now = Date.now()
): BackgroundResumeVerdict {
  if (!isRestoreFloodGuardOn(state.settings)) {
    return { hold: false, reason: 'guard-off' }
  }
  const kind = classifyGuardedResume({
    record: target.record,
    liveEntryWorking: target.liveEntryWorking,
    liveEntryDriven: target.liveEntryDriven,
    deferredStartup: target.deferredStartup,
    putAway: () => isPaneKeyPutAway(target.paneKey)
  })
  if (!kind) {
    return { hold: false, reason: 'not-guarded' }
  }
  const { record, entry } = target
  const keep = resolveResumeKeepReason({
    now,
    visible: target.visible,
    // Why not the record's last message: a held resume keeps the record, so its ask is answered
    // when the tab is opened; as a release, the text heuristic resumed most finished agents.
    openAsk: hasLiveInteractiveAsk(entry),
    tabLastSeenAt: getForegroundTerminalTabLastSeenAtById()[target.tabId],
    tabRevealedAt: getForegroundTerminalTabRevealedAt(target.tabId),
    personRevealedAt: getPersonRevealedAt(target.tabId),
    lastTerminalInputAt: state.lastTerminalInputAtByPaneKey?.[target.paneKey],
    ...(record ? { capturedAt: record.capturedAt } : {})
  })
  return keep ? { hold: false, reason: keep } : { hold: true, kind }
}
