import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AgentStatusState } from '../../../shared/agent-status-types'
import type { SessionManageState } from '../../../shared/session-manage-types'

// Why: 2026-09-30 a background mount (the in-app browser's whole-workspace lease) of one folder
// workspace resumed 51 finished agents within a minute (load ~17 on 24 cores). Completed-agent
// hibernation writes those records with origin 'worktree-sleep', state 'done' and NO
// restoreOnTabOpenOnly, so the guard is keyed on what a record IS, not on that flag: a mount no
// person asked for never resumes a finished, tab-open-only or put-away agent. Absent means on;
// false is the kill switch back to the earlier eager restore.
export function isRestoreFloodGuardOn(
  settings: Pick<GlobalSettings, 'restoreFloodGuard'> | null | undefined
): boolean {
  return settings?.restoreFloodGuard !== false
}

/** G2: a person touched the pane this recently, so nothing may treat it as idle. */
export const RECENT_HUMAN_TOUCH_MS = 10 * 60_000

/** G5: an agent that was mid-task when the app went away ('quit') or was checkpointed live.
 *  The interrupted-restore auto-continue must keep resuming these, so no flood rule gates them. */
export function isInterruptedWorkingRecord(
  record: Pick<SleepingAgentSessionRecord, 'origin' | 'state'>
): boolean {
  return (record.origin === 'quit' || record.origin === 'live') && record.state === 'working'
}

export type GuardedResumeKind =
  /** Completed-agent hibernation (or a manual sleep): origin 'worktree-sleep' (legacy records have
   *  no origin), state 'done'. */
  | 'finished-sleep'
  /** A 'quit' or 'live' checkpoint of an agent that was NOT mid-task (idle at its prompt, done,
   *  or waiting): G5 exempts only state 'working', so nothing auto-continues these. */
  | 'idle-checkpoint'
  /** restoreOnTabOpenOnly / resumeOnFirstReveal, or a lazily restored startup: resumes on open. */
  | 'on-open'
  /** Archived, hidden or deleted in the sidebar (isPutAwayPaneKey). */
  | 'put-away'

export type GuardedResumeInput = {
  record: Pick<
    SleepingAgentSessionRecord,
    'origin' | 'state' | 'restoreOnTabOpenOnly' | 'resumeOnFirstReveal'
  > | null
  /** The resume comes from a live status row that is mid-turn (no sleeping record used). */
  liveEntryWorking?: boolean
  /** The resume comes from a live status row, whatever its state (no sleeping record used). */
  liveEntryDriven?: boolean
  /** The pane's queued startup waits for its first reveal (a lazily restored tab). */
  deferredStartup?: boolean
  /** Archived/hidden/deleted; a function so the sidebar model is read only when it decides. */
  putAway: boolean | (() => boolean)
}

/** What a mount no person asked for must not resume; null when it may (the pre-guard path). */
export function classifyGuardedResume(input: GuardedResumeInput): GuardedResumeKind | null {
  const { record } = input
  const isPutAway = (): boolean =>
    typeof input.putAway === 'function' ? input.putAway() : input.putAway
  // Why put-away first for mid-task agents: G5 keeps the interrupted-restore auto-continue
  // running, and that auto-continue skips archived, hidden and deleted panes (#921). A background
  // mount must not resume what the person put away just because it was mid-task either.
  if ((record && isInterruptedWorkingRecord(record)) || (!record && input.liveEntryWorking)) {
    return isPutAway() ? 'put-away' : null
  }
  // Why legacy too: records written before `origin` existed are worktree-sleep records.
  if (record && (record.origin === 'worktree-sleep' || !record.origin) && record.state === 'done') {
    return 'finished-sleep'
  }
  if (
    record?.restoreOnTabOpenOnly === true ||
    record?.resumeOnFirstReveal === true ||
    input.deferredStartup === true
  ) {
    return 'on-open'
  }
  // Why: the commonest record after an update or restart is a 'quit' checkpoint of an agent idle at
  // its prompt. Cold activation leaves those tabs unmounted (local hosts), and every other mount
  // (SSH or runtime-host activation, a split tab mounted for a sibling's live PTY) must hold them
  // the same way, or the two layers disagree on what a background mount may resume.
  if (record && (record.origin === 'quit' || record.origin === 'live')) {
    return 'idle-checkpoint'
  }
  // Why: a quit or periodic capture skips 'done' rows (it only re-stamps a Pi-compatible agent's
  // existing record), so an agent finished when the app went away comes back as a hydrated 'done'
  // row alone. Read as "nothing to guard", an SSH tab whose remote PTYs died or a split tab mounted
  // for a sibling's live PTY resumed it from the background. Only G5's mid-turn row auto-continues.
  if (!record && input.liveEntryDriven) {
    return isPutAway() ? 'put-away' : 'idle-checkpoint'
  }
  return isPutAway() ? 'put-away' : null
}

const NUMBERED_QUESTION_LINE = /^\s*\d+\./

/**
 * The open ask a rule that only HOLDS a resume may release on: the agent's live hook row is
 * blocked or waiting on a concrete interactive prompt. G1 was written for rules that STOP an agent,
 * where losing the agent would lose the ask. A held resume loses nothing: the record stays
 * resumable (it is never cleared while held), the sidebar still shows its last message, and the
 * person's reveal resumes it in the admission priority lane. Reading hasOpenAsk's text heuristic
 * (a trailing "?" or two "1." lines) as a release resumed most finished agents from the background,
 * since an ordinary final summary is a numbered list — the very flood the guard exists to stop.
 * A row hydrated from last-status.json with no live hook since (restoredUnconfirmed) is not live:
 * main keeps its last state and prompt across a restart, so every agent that sat at a prompt when
 * the app went away would otherwise read as asking and resume from the background.
 */
export function hasLiveInteractiveAsk(
  entry:
    | {
        state?: AgentStatusState | null
        interactivePrompt?: string | null
        restoredUnconfirmed?: boolean | null
      }
    | null
    | undefined
): boolean {
  if (
    !entry ||
    entry.restoredUnconfirmed === true ||
    (entry.state !== 'blocked' && entry.state !== 'waiting')
  ) {
    return false
  }
  return typeof entry.interactivePrompt === 'string' && entry.interactivePrompt.trim().length > 0
}

/** G1 for rules that STOP or sleep an agent: the agent is waiting on the person. `sessionState` is
 *  the Stage A1 reader's verdict when one is at hand; `state` is the hook state it reads it from
 *  (blocked/waiting = awaiting-user, session-manage-hook-activity.ts). Hook `done` is NOT proof of
 *  idle: the last assistant message ending in "?" or holding a numbered question list (2+ lines
 *  "1.") is an open ask too — on 2026-09-30 a session holding Sal's 3 numbered questions sat at
 *  `done` for 42 minutes. Rules that only hold a resume use hasLiveInteractiveAsk instead. */
export function hasOpenAsk(input: {
  sessionState?: SessionManageState | null
  state?: AgentStatusState | null
  interactivePrompt?: string | null
  lastAssistantMessage?: string | null
}): boolean {
  if (input.sessionState === 'awaiting-user' || input.sessionState === 'waiting-for-yes') {
    return true
  }
  if (input.state === 'blocked' || input.state === 'waiting') {
    return true
  }
  if (typeof input.interactivePrompt === 'string' && input.interactivePrompt.trim().length > 0) {
    return true
  }
  const message = input.lastAssistantMessage?.trim()
  if (!message) {
    return false
  }
  if (message.endsWith('?')) {
    return true
  }
  let numbered = 0
  for (const line of message.split(/\r?\n/)) {
    if (NUMBERED_QUESTION_LINE.test(line)) {
      numbered += 1
      if (numbered >= 2) {
        return true
      }
    }
  }
  return false
}

export type ResumeKeepReason = 'visible' | 'open-ask' | 'recent-touch' | 'revealed-after-sleep'

export type ResumeKeepInput = {
  now: number
  /** G3: the pane's live visibility (isVisibleRef — the predicate pty-exit-hibernate uses). */
  visible: boolean
  /** For a held resume: a live interactive ask (hasLiveInteractiveAsk), not the text heuristic. */
  openAsk: boolean
  /** When the tab was last in the foreground (foregroundTerminalLastSeenAtByTabId): G2 only. It
   *  is refreshed when the tab LEAVES the foreground too, so it never proves a reveal after a
   *  sleep. */
  tabLastSeenAt?: number
  /** When the tab last ENTERED the foreground (foregroundTerminalRevealedAtByTabId). */
  tabRevealedAt?: number
  /** When a person opened the tab outside the desktop tab strip (the phone's per-terminal open). */
  personRevealedAt?: number
  /** lastTerminalInputAtByPaneKey for the pane. */
  lastTerminalInputAt?: number
  /** The sleeping record's capturedAt, when a record is what would resume. */
  capturedAt?: number
}

/** G1-G3 plus "a person revealed the tab after it slept": any of them lets the resume run. */
export function resolveResumeKeepReason(input: ResumeKeepInput): ResumeKeepReason | null {
  if (input.visible) {
    return 'visible'
  }
  if (input.openAsk) {
    return 'open-ask'
  }
  const touchedAt = Math.max(
    input.tabLastSeenAt ?? Number.NEGATIVE_INFINITY,
    input.personRevealedAt ?? Number.NEGATIVE_INFINITY,
    input.lastTerminalInputAt ?? Number.NEGATIVE_INFINITY
  )
  if (Number.isFinite(touchedAt) && input.now - touchedAt <= RECENT_HUMAN_TOUCH_MS) {
    return 'recent-touch'
  }
  // Why reveal starts, not last-seen: a tab put to sleep while on screen is "last seen" when the
  // person leaves it, after capturedAt, though nobody opened it since it slept.
  const revealedAt = Math.max(
    input.tabRevealedAt ?? Number.NEGATIVE_INFINITY,
    input.personRevealedAt ?? Number.NEGATIVE_INFINITY
  )
  if (
    typeof input.capturedAt === 'number' &&
    Number.isFinite(revealedAt) &&
    revealedAt > input.capturedAt
  ) {
    return 'revealed-after-sleep'
  }
  return null
}

// Why module state: the phone's per-terminal open is a person opening that one tab. Tab ids are
// globally unique UUIDs, so entries for closed tabs are harmless and pruned past the G2 window.
const personRevealedAtByTabId = new Map<string, number>()

export function notePersonRevealedTab(tabId: string, now = Date.now()): void {
  personRevealedAtByTabId.set(tabId, now)
  for (const [candidate, at] of personRevealedAtByTabId) {
    if (now - at > RECENT_HUMAN_TOUCH_MS) {
      personRevealedAtByTabId.delete(candidate)
    }
  }
}

export function getPersonRevealedAt(tabId: string): number | undefined {
  return personRevealedAtByTabId.get(tabId)
}

export function resetPersonRevealsForTests(): void {
  personRevealedAtByTabId.clear()
}
