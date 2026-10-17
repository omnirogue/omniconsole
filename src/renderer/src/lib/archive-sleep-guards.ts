import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  ARCHIVE_SLEEP_IDLE_MS,
  ARCHIVE_SLEEP_RECENT_TOUCH_MS,
  isOpenAskText,
  type ArchiveSleepKeep
} from '../../../shared/archive-sleep-contract'

/** What a person did to a pane recently, read fresh right before every action (G4). */
export type ArchiveSleepTouch = {
  now: number
  /** Tabs this window treats as foreground now. */
  foregroundTabIds: readonly string[]
  /** When each tab was last on screen (`foregroundTerminalLastSeenAtByTabId`). */
  lastSeenAtByTabId: Readonly<Record<string, number | undefined>>
  /** Last keystroke per pane, including one not flushed to the store yet. */
  inputAtByPaneKey: Readonly<Record<string, number | undefined>>
  /** The pane's own live visibility, the one pty-exit-hibernate.ts reads (`isVisibleRef`). */
  isTabVisible: (tabId: string) => boolean
  /** A person (the phone, or the desktop taking it back) holds the PTY's driver seat. */
  isPtyDriven: (ptyId: string) => boolean
  /** When a person last let go of that seat (`getDriverReleasedAtForPty`). */
  ptyDriverReleasedAt: (ptyId: string) => number | undefined
}

type GuardedPane = {
  paneKey: string
  tabId: string
  ptyId: string
  status: AgentStatusEntry
  record: SleepingAgentSessionRecord | undefined
  touch: ArchiveSleepTouch
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function recentlyTouched({ paneKey, tabId, ptyId, touch }: GuardedPane): boolean {
  const recent = (at: number | undefined): boolean =>
    finite(at) > 0 && touch.now - finite(at) < ARCHIVE_SLEEP_RECENT_TOUCH_MS
  return (
    touch.foregroundTabIds.includes(tabId) ||
    recent(touch.lastSeenAtByTabId[tabId]) ||
    recent(touch.inputAtByPaneKey[paneKey]) ||
    touch.isPtyDriven(ptyId) ||
    // Why: a phone read types nothing and reveals no tab; its release is the only trace.
    recent(touch.ptyDriverReleasedAt(ptyId))
  )
}

/**
 * G1 fails closed: a Done row whose reply this window never received, or received as a tool's
 * output, is no proof that nothing was asked.
 */
function replyUnread(status: AgentStatusEntry): boolean {
  return !status.lastAssistantMessage?.trim() || status.lastAssistantMessageIsToolOutput === true
}

/**
 * The keeps every archive sleep enforces on a local pane whose agent reads Done: G3 visible,
 * G2 recent human touch, G1 an open ask, G5 a mid-task quit/live record. Null when none holds.
 * Why G1 here too: a hook's `done` is no proof of idle; the host re-reads Stage A1 as well.
 */
export function archiveSleepKeep(pane: GuardedPane): ArchiveSleepKeep | null {
  const { status, record } = pane
  if (pane.touch.isTabVisible(pane.tabId)) {
    return 'visible'
  }
  if (recentlyTouched(pane)) {
    return 'recent-touch'
  }
  if (
    status.state === 'waiting' ||
    status.state === 'blocked' ||
    status.interactivePrompt ||
    isOpenAskText(status.lastAssistantMessage)
  ) {
    return 'open-ask'
  }
  if (replyUnread(status)) {
    return 'unreadable'
  }
  // Why: sleeping it would overwrite that record with a tab-open-only one, and interrupted
  // restore (restore-interrupted-background-panes.ts) must keep resuming work that was mid-task.
  if ((record?.origin === 'quit' || record?.origin === 'live') && record.state === 'working') {
    return 'interrupted-restore'
  }
  return null
}

/**
 * When a non-person archive may sleep the pane: ARCHIVE_SLEEP_IDLE_MS after the latest of its
 * archive, its finished turn, its last reveal, its last keystroke and the last time a person let
 * go of its driver seat. An agent that is not Done, a pane on screen or a PTY a person drives now
 * starts a fresh period from now.
 */
export function archiveSleepIdleDueAt(
  armedAt: number,
  status: AgentStatusEntry | undefined,
  pane: { tabId: string; paneKey: string; ptyId: string | null },
  touch: ArchiveSleepTouch
): number {
  if (
    status?.state !== 'done' ||
    touch.isTabVisible(pane.tabId) ||
    touch.foregroundTabIds.includes(pane.tabId) ||
    (pane.ptyId !== null && touch.isPtyDriven(pane.ptyId))
  ) {
    return touch.now + ARCHIVE_SLEEP_IDLE_MS
  }
  return (
    Math.max(
      armedAt,
      finite(status.stateStartedAt),
      finite(touch.lastSeenAtByTabId[pane.tabId]),
      finite(touch.inputAtByPaneKey[pane.paneKey]),
      pane.ptyId === null ? 0 : finite(touch.ptyDriverReleasedAt(pane.ptyId))
    ) + ARCHIVE_SLEEP_IDLE_MS
  )
}
