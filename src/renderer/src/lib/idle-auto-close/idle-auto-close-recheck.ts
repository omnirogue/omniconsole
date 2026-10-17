import { readAutomaticCleanupProtection } from '../automatic-session-cleanup-protection'
/**
 * G4 for the idle rules: immediately before R2 puts a workspace's shells to sleep or R3 discards a
 * workspace's pages, re-read that one target — on screen (G3), a person's touch (G2), an open ask
 * (G1, from the panes' own words and main's Stage A1 reading), a mid-task restore record (G5) and,
 * for shells, that the workspace is still the same set of bare shells with nothing running in
 * them now and no agent state. Returns why it stays, or null when the act may go ahead.
 */

import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import {
  getEffectiveIdleAutoCloseMs,
  IDLE_RULE,
  keepReasonFromReading,
  type IdleKeepReading
} from '../../../../shared/idle-auto-close-settings'
import { isShellProcess } from '../../../../shared/shell-process-detection'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { IdleDecision, IdleShellTab } from './idle-auto-close-decision'
import type { IdleAutoCloseDeps } from './idle-auto-close-deps'
import { isPinnedTabOrWorkspace, workspaceHoldsAgentState } from './idle-auto-close-keep'
import { paneHeldAgentThisSession } from './agent-pane-history'
import { hiddenSinceByWorktreeId } from './idle-auto-close-observations'
import { hiddenBrowserKeepReason } from './idle-auto-close-rules'
import {
  isInterruptedRestoreRecord,
  isRecentHumanTouch,
  isTerminalTabOnScreen,
  lastHumanTouchAt,
  paneHoldsOpenAsk
} from './idle-keep-guards'

/** Most panes one `idleAutoClose.keepReadings` call reads. */
const READINGS_PER_CALL = 20

function sortedJoin(values: Iterable<string>): string {
  return [...values].sort().join('|')
}

/** One planned tab: still bound to the planned PTYs only, off screen, untouched, no agent. */
function shellTabKeepReason(
  state: AppState,
  worktreeId: string,
  shell: IdleShellTab,
  now: number
): string | null {
  const { tabId, paneKeys, ptyIds } = shell
  const bound = Object.entries(state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {})
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([leafId, ptyId]) => `${makePaneKey(tabId, leafId)}=${ptyId}`)
  const planned = paneKeys.map((paneKey, index) => `${paneKey}=${ptyIds[index]}`)
  // Why the live PTY list too: the stop ends every live PTY of the tab, so each must be one the
  // plan inspected.
  if (
    paneKeys.length === 0 ||
    sortedJoin(bound) !== sortedJoin(planned) ||
    sortedJoin(new Set(state.ptyIdsByTabId[tabId] ?? [])) !== sortedJoin(new Set(ptyIds))
  ) {
    return 'changed'
  }
  if (isTerminalTabOnScreen(tabId)) {
    return 'visible'
  }
  if (isPinnedTabOrWorkspace(state, worktreeId, tabId)) {
    return 'pinned'
  }
  if (isRecentHumanTouch(lastHumanTouchAt({ state, tabId, paneKeys, ptyIds, now }), now)) {
    return 'recent-touch'
  }
  for (const paneKey of paneKeys) {
    const protection = readAutomaticCleanupProtection(state, { worktreeId, tabId, paneKey }, now)
    if (protection) {
      return protection
    }
    if (isInterruptedRestoreRecord(state.sleepingAgentSessionsByPaneKey[paneKey])) {
      return 'interrupted-restore'
    }
    if (paneHoldsOpenAsk(state, paneKey)) {
      return 'open-ask'
    }
    if (state.agentStatusByPaneKey[paneKey] || state.sleepingAgentSessionsByPaneKey[paneKey]) {
      return 'agent-pane'
    }
    if (paneHeldAgentThisSession(paneKey)) {
      return 'agent-history'
    }
  }
  return null
}

/** The window-side keeps for a shell workspace: not shown, the same tabs, each still idle. */
export function shellWorkspaceWindowKeepReason(decision: IdleDecision, now: number): string | null {
  const state = useAppStore.getState()
  const worktreeId = decision.key
  const shellTabs = decision.shellTabs ?? []
  if (worktreeId === state.activeWorktreeId) {
    return 'active-workspace'
  }
  const tabIds = (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
  if (shellTabs.length === 0 || sortedJoin(tabIds) !== sortedJoin(shellTabs.map((t) => t.tabId))) {
    return 'changed'
  }
  for (const shell of shellTabs) {
    const reason = shellTabKeepReason(state, worktreeId, shell, now)
    if (reason) {
      return reason
    }
  }
  return workspaceHoldsAgentState(state, worktreeId) ? 'agent-state' : null
}

async function readKeepInChunks(
  deps: IdleAutoCloseDeps,
  targets: readonly { worktreeId: string; paneKey: string }[]
): Promise<IdleKeepReading[]> {
  const readings: IdleKeepReading[] = []
  for (let start = 0; start < targets.length; start += READINGS_PER_CALL) {
    readings.push(...(await deps.readKeep(targets.slice(start, start + READINGS_PER_CALL))))
  }
  return readings
}

async function recheckShellWorkspace(
  decision: IdleDecision,
  deps: IdleAutoCloseDeps,
  now: number
): Promise<string | null> {
  const first = shellWorkspaceWindowKeepReason(decision, now)
  if (first) {
    return first
  }
  const worktreeId = decision.key
  const shellTabs = decision.shellTabs ?? []
  const paneKeys = shellTabs.flatMap((shell) => shell.paneKeys)
  const readings = await readKeepInChunks(
    deps,
    paneKeys.map((paneKey) => ({ worktreeId, paneKey }))
  )
  for (const paneKey of paneKeys) {
    // Why an unlisted pane is fine here: a bare shell need not be a conversation row.
    const reason = keepReasonFromReading(readings.find((reading) => reading.paneKey === paneKey))
    if (reason) {
      return reason
    }
  }
  for (const ptyId of shellTabs.flatMap((shell) => shell.ptyIds)) {
    let inspection: Awaited<ReturnType<IdleAutoCloseDeps['inspectProcess']>>
    try {
      inspection = await deps.inspectProcess(ptyId)
    } catch {
      return 'process-unknown'
    }
    if (inspection.unavailable) {
      return 'process-unknown'
    }
    if (inspection.hasChildProcesses) {
      return 'has-children'
    }
    if (!inspection.foregroundProcess || !isShellProcess(inspection.foregroundProcess)) {
      return 'foreground-not-shell'
    }
  }
  // The person may have opened or typed into it while main and the process table answered.
  return shellWorkspaceWindowKeepReason(decision, now)
}

function recheckHiddenPages(
  decision: IdleDecision,
  deps: IdleAutoCloseDeps,
  now: number
): string | null {
  const state = useAppStore.getState()
  return hiddenBrowserKeepReason(
    {
      now,
      idleMs: getEffectiveIdleAutoCloseMs(state.settings?.idleAutoCloseMinutes),
      activeWorktreeId: state.activeWorktreeId,
      hiddenSinceByWorktreeId,
      holdsLiveGuests: (worktreeId) => deps.holdsLiveGuests(state, worktreeId),
      isEvictable: (worktreeId) => deps.isGuestEvictable(state, worktreeId),
      isPlayingAudio: (worktreeId) => deps.isGuestPlayingAudio(state, worktreeId)
    },
    decision.key,
    hiddenSinceByWorktreeId.get(decision.key)
  )
}

export async function recheckIdleDecision(
  decision: IdleDecision,
  deps: IdleAutoCloseDeps,
  now: number
): Promise<string | null> {
  try {
    return decision.rule === IDLE_RULE.R2
      ? await recheckShellWorkspace(decision, deps, now)
      : recheckHiddenPages(decision, deps, now)
  } catch {
    return 'unreadable'
  }
}
