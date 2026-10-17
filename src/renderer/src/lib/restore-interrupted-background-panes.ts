import { useAppStore, type AppState } from '@/store'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { buildPaneSessions } from './sidebar-sessions'
import { setPutAwayPaneReader } from './restore-flood-resume-verdict'
import { subscribeAgentStartAbandoned } from './agent-start-in-flight'
import {
  createPutAwayPaneCheck,
  isPutAwayRow,
  paneSessionInputsChanged
} from './put-away-pane-check'
import type { SessionSidebarView } from './session-sidebar-view'
import type { SessionSidebarViewState } from '@/store/session-sidebar-view-state'

/**
 * A pane the person put away must stay put away across a relaunch. Archive, Hide and Delete
 * only change how the row is shown (they never stop the agent), so before this check every
 * preserved "working" pane came back after an app restart or update — including the ones
 * Sal had archived to get them out of the way (2026-09-30, 25 panes relaunched at once).
 * Keyed exactly as the sidebar keys them (`conversationViewKey`), so what the sidebar treats
 * as archived is what restore treats as archived.
 */
export function isPutAwayPaneKey(
  paneKey: string,
  state: Parameters<typeof buildPaneSessions>[0],
  view: SessionSidebarView,
  archived: readonly string[]
): boolean {
  return isPutAwayRow(
    buildPaneSessions(state).find((row) => row.paneKey === paneKey),
    view,
    archived
  )
}

/** How often one pane's mount is re-requested after its queued start was dropped. */
const MAX_ABANDONED_START_RETRIES = 3

/** The store slices a restore pass reads itself; the rows it checks for "put away" read more. */
const RESTORE_PASS_SLICES = [
  'workspaceSessionReady',
  'settings',
  'sleepingAgentSessionsByPaneKey',
  'tabsByWorktree'
] as const satisfies readonly (keyof AppState)[]

function restorePassInputsChanged(state: AppState, prev: AppState): boolean {
  return RESTORE_PASS_SLICES.some((key) => state[key] !== prev[key])
}

function personalViewChanged(
  view: SessionSidebarViewState,
  prev: SessionSidebarViewState
): boolean {
  return view.loaded !== prev.loaded || view.view !== prev.view || view.archived !== prev.archived
}

/**
 * Mount only preserved local panes whose agent was mid-turn, so auto-continue can finish the work.
 * Every other restored tab stays lazy: it spawns and resumes when the user first opens it (#857).
 * The restore flood guard never gates these 'quit'/'live' working records (G5): this background
 * path keeps running with the guard on, and the pane's connect gate lets their resume through.
 */
export function installInterruptedBackgroundPaneRestore(): () => void {
  const requested = new Set<string>()
  const retriesByPaneKey = new Map<string, number>()
  // Why: one rebuild of the pane rows per change to what they are built from, not one per record
  // per store write (a put-away record never reaches `requested`, so it was re-checked forever).
  const isPutAway = createPutAwayPaneCheck()
  // Working panes the last pass skipped as put away: the only verdicts a change to the rows'
  // other inputs (agent status, layouts, owners) can flip, so only they make such a change re-run.
  const putAwayWaiting = new Set<string>()
  const restore = (): void => {
    putAwayWaiting.clear()
    const state = useAppStore.getState()
    if (
      !state.workspaceSessionReady ||
      state.settings?.activeRuntimeEnvironmentId ||
      state.settings?.autoContinueInterruptedSessions === false
    ) {
      return
    }
    const viewStore = useSessionSidebarView.getState()
    if (!viewStore.loaded) {
      // Why: until the personal view is read, an archived pane is indistinguishable from a
      // live one; relaunching it first and asking later is the bug this file guards against.
      viewStore.load()
      return
    }
    for (const record of Object.values(state.sleepingAgentSessionsByPaneKey ?? {})) {
      if (
        (record.origin !== 'live' && record.origin !== 'quit') ||
        // Why: every resumable agent keeps a live record, so mounting them all reopened each idle
        // agent tab (and its shell, when the resume exited) on every relaunch.
        record.state !== 'working' ||
        record.connectionId ||
        record.restoreOnTabOpenOnly ||
        record.automaticResumeBlockedBy ||
        requested.has(record.paneKey)
      ) {
        continue
      }
      const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
      if (!tabId || !state.tabsByWorktree?.[record.worktreeId]?.some((tab) => tab.id === tabId)) {
        continue
      }
      if (isPutAway(record.paneKey, state, viewStore.view, viewStore.archived)) {
        putAwayWaiting.add(record.paneKey)
        continue
      }
      requested.add(record.paneKey)
      requestBackgroundTerminalWorktreeMount({ worktreeId: record.worktreeId, tabIds: [tabId] })
    }
  }
  // Why gated: the store is written at least every 500 ms while a person types; a pass whose
  // inputs did not change would reach the same verdicts, so it does not run.
  const unsubscribe = useAppStore.subscribe((state, prev) => {
    if (
      restorePassInputsChanged(state, prev) ||
      (putAwayWaiting.size > 0 && paneSessionInputsChanged(state, prev))
    ) {
      restore()
    }
  })
  const unsubscribeView = useSessionSidebarView.subscribe((view, prev) => {
    if (personalViewChanged(view, prev)) {
      restore()
    }
  })
  // Why: main admits 3 agent starts per 10 s, so a mounted pane's resume can wait in its queue;
  // if the pane goes away meanwhile its start is dropped (no slot used) and, as a requested pane,
  // it would never be mounted again. Forget it so the next pass re-requests it while its record
  // still says mid-task — a bounded number of times, so a pane that keeps going away can't loop.
  const unsubscribeAbandoned = subscribeAgentStartAbandoned((paneKey) => {
    if (!requested.has(paneKey)) {
      return
    }
    const retries = retriesByPaneKey.get(paneKey) ?? 0
    if (retries >= MAX_ABANDONED_START_RETRIES) {
      return
    }
    retriesByPaneKey.set(paneKey, retries + 1)
    requested.delete(paneKey)
    restore()
  })
  // Why here: the restore flood guard treats an archived/hidden/deleted pane as one no background
  // mount may resume, and must read "put away" exactly as this file does. An unread personal
  // view reads as not put away; the guard's other classes still hold.
  const unregisterPutAwayReader = setPutAwayPaneReader((paneKey) => {
    const viewStore = useSessionSidebarView.getState()
    return (
      viewStore.loaded &&
      isPutAway(paneKey, useAppStore.getState(), viewStore.view, viewStore.archived)
    )
  })
  restore()
  return () => {
    unsubscribe()
    unsubscribeView()
    unsubscribeAbandoned()
    unregisterPutAwayReader()
  }
}
