import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { getForegroundTerminalTabLastSeenAtById } from '@/lib/foreground-terminal-tabs'
import {
  RECENT_HUMAN_TOUCH_MS,
  getPersonRevealedAt,
  hasLiveInteractiveAsk,
  isInterruptedWorkingRecord,
  isRestoreFloodGuardOn
} from '@/lib/restore-flood-guard'
import { isPaneKeyPutAway } from '@/lib/restore-flood-resume-verdict'
import { REMOTE_PTY_ID_PREFIX } from '../terminal-pane/pty-connection/pty-connect-limits'

// Why: cold activation mounts every restored tab a parked watcher cannot cover, and a restored
// tab whose PTY is gone cannot be covered — so each one mounted at once and cold-restored
// (resumed) its agent in the background (#857, the 2026-09-30 flood). Under the restore flood
// guard such a tab defers like a coverable one and mounts on its first reveal. Tabs with a
// startup queued in THIS app session (pendingStartupByTabId is never persisted: orchestration
// and CLI workers) are immediate and never reach this check.

type ActivationTab = { id: string; ptyId?: string | null }

export type ActivationDeferralState = {
  settings: Pick<GlobalSettings, 'restoreFloodGuard'> | null
  ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
  pendingStartupByTabId: Readonly<Record<string, unknown>>
  terminalLayoutsByTabId: Readonly<
    Record<string, { ptyIdsByLeafId?: Readonly<Record<string, string>> } | undefined>
  >
  sleepingAgentSessionsByPaneKey: Readonly<Record<string, SleepingAgentSessionRecord>>
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry>>
  lastTerminalInputAtByPaneKey?: Readonly<Record<string, number | undefined>>
}

function tabIdOfPaneKey(paneKey: string): string | null {
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

/** PTY ids the restored tab recorded (tab binding and per-leaf layout bindings). */
export function collectRecordedTabPtyIds(
  tab: ActivationTab,
  state: Pick<ActivationDeferralState, 'terminalLayoutsByTabId'>
): string[] {
  const ids = new Set<string>()
  if (tab.ptyId) {
    ids.add(tab.ptyId)
  }
  for (const ptyId of Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {})) {
    if (ptyId) {
      ids.add(ptyId)
    }
  }
  return [...ids]
}

/** A tab the guard may leave unmounted at cold activation: restored, with no PTY this renderer
 *  holds live, only local PTY ids (pty:hasPty can vouch for them), and none of the guards that
 *  keep an agent resumable in the background (a live interactive ask, G2 recent touch, G5
 *  mid-task). A mid-task agent the person archived, hid or deleted is not kept: the
 *  interrupted-restore auto-continue skips those too (#921). An agent whose last message reads
 *  like a question stays deferred: its record keeps it resumable, and opening the tab resumes it
 *  (hasLiveInteractiveAsk says why the text heuristic is no release for a held resume). */
export function isGuardDeferrableRestoredTab(
  tab: ActivationTab,
  state: ActivationDeferralState,
  isTabLive: (tabId: string) => boolean,
  now = Date.now(),
  isPutAway: (paneKey: string) => boolean = isPaneKeyPutAway
): boolean {
  if (isTabLive(tab.id) || (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0) {
    return false
  }
  if (state.pendingStartupByTabId[tab.id] !== undefined) {
    return false
  }
  const recordedPtyIds = collectRecordedTabPtyIds(tab, state)
  if (
    recordedPtyIds.some(
      (ptyId) => ptyId.startsWith(REMOTE_PTY_ID_PREFIX) || parseAppSshPtyId(ptyId) !== null
    )
  ) {
    return false
  }
  const records = Object.values(state.sleepingAgentSessionsByPaneKey).filter(
    (record) => (record.tabId ?? tabIdOfPaneKey(record.paneKey)) === tab.id
  )
  // Why: a tab with neither a recorded PTY nor a record is new, not restored; it mounts to spawn.
  if (recordedPtyIds.length === 0 && records.length === 0) {
    return false
  }
  if (records.some((record) => isInterruptedWorkingRecord(record) && !isPutAway(record.paneKey))) {
    return false
  }
  const entries = Object.values(state.agentStatusByPaneKey).filter(
    (entry) => tabIdOfPaneKey(entry.paneKey) === tab.id
  )
  // Why: as the connect gate reads it (cold-restore-gate-target.ts), a row hydrated from
  // last-status.json (restoredUnconfirmed) is no proof of a turn when the pane has a sleeping record.
  const recordPaneKeys = new Set(records.map((record) => record.paneKey))
  const isLiveWorking = (entry: AgentStatusEntry): boolean =>
    entry.state === 'working' &&
    !(entry.restoredUnconfirmed === true && recordPaneKeys.has(entry.paneKey))
  if (entries.some((entry) => isLiveWorking(entry) && !isPutAway(entry.paneKey))) {
    return false
  }
  if (entries.some((entry) => hasLiveInteractiveAsk(entry))) {
    return false
  }
  const touches = [
    getForegroundTerminalTabLastSeenAtById()[tab.id],
    getPersonRevealedAt(tab.id),
    ...Object.entries(state.lastTerminalInputAtByPaneKey ?? {})
      .filter(([paneKey]) => paneKey.startsWith(`${tab.id}:`))
      .map(([, at]) => at)
  ]
  return !touches.some((at) => typeof at === 'number' && now - at <= RECENT_HUMAN_TOUCH_MS)
}

/**
 * The tabs the guard itself leaves unmounted at cold activation. A tab parked byte watchers can
 * already cover is left out: the #857 deferral keeps it unmounted until revealed as before, and
 * the guard must not claim it — its pty:hasPty probe mounts every guard-deferred tab whose PTY
 * survived, which for coverable tabs would turn that lazy deferral into an eager mount storm
 * (xterm + snapshot replay per tab) after a restart with a surviving daemon.
 */
export function collectGuardDeferrableRestoredTabIds<Tab extends ActivationTab>(args: {
  state: ActivationDeferralState
  tabs: readonly Tab[]
  isTabLive: (tabId: string) => boolean
  /** The cold-activation coverage gate (canWatcherCoverParkedTerminalTab, when parking and the
   *  host support deferral). */
  isWatcherCoverable?: (tab: Tab) => boolean
  now?: number
  isPutAway?: (paneKey: string) => boolean
}): Set<string> {
  const deferrable = new Set<string>()
  if (!isRestoreFloodGuardOn(args.state.settings)) {
    return deferrable
  }
  const now = args.now ?? Date.now()
  for (const tab of args.tabs) {
    if (args.isWatcherCoverable?.(tab) === true) {
      continue
    }
    if (isGuardDeferrableRestoredTab(tab, args.state, args.isTabLive, now, args.isPutAway)) {
      deferrable.add(tab.id)
    }
  }
  return deferrable
}

/**
 * The renderer has no synchronous copy of the daemon's PTY list, so a guard-deferred tab whose
 * recorded PTY survived the restart is found by asking the provider (pty:hasPty) and mounted at
 * once — a live PTY reattaches and never runs a command, and its watchers need a pane.
 */
export async function mountGuardDeferredTabsWithLivePty(args: {
  worktreeId: string
  tabs: readonly ActivationTab[]
  state: Pick<ActivationDeferralState, 'terminalLayoutsByTabId'>
  hasPty: (ptyId: string) => Promise<boolean | null>
  requestMount: (detail: { worktreeId: string; tabIds: string[] }) => void
}): Promise<string[]> {
  const mounted: string[] = []
  await Promise.all(
    args.tabs.map(async (tab) => {
      const answers = await Promise.all(
        collectRecordedTabPtyIds(tab, args.state).map((ptyId) =>
          args.hasPty(ptyId).catch(() => null)
        )
      )
      if (answers.includes(true)) {
        mounted.push(tab.id)
        args.requestMount({ worktreeId: args.worktreeId, tabIds: [tab.id] })
      }
    })
  )
  return mounted
}
