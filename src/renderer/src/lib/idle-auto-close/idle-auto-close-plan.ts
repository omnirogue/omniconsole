/**
 * Builds R2's inputs from the store, the daemon listing and the runtime's terminals, and returns
 * its decisions (one per workspace) for this tick. The cheap checks run first; the saved/pinned
 * sidebar read and the process inspections run only for workspaces whose shells passed them.
 */

import type { AppState } from '@/store/types'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import { getForegroundTerminalTabLastSeenAtById } from '../foreground-terminal-tabs'
import { mergePendingTerminalInputActivity } from '../terminal-input-activity-coalescing'
import { planIdleShellWorkspaces } from './idle-auto-close-bare-shell-rule'
import type { IdleDecision, ProcessInspection } from './idle-auto-close-decision'
import type { IdleAutoCloseDeps } from './idle-auto-close-deps'
import {
  getNonLocalWorktreeIds,
  isPinnedTabOrWorkspace,
  workspaceHoldsAgentState
} from './idle-auto-close-keep'
import { paneHeldAgentThisSession, rememberAgentPane } from './agent-pane-history'
import {
  currentInspections,
  firstObservedAtByPtyId,
  rememberInspection
} from './idle-auto-close-observations'
import {
  isInterruptedRestoreRecord,
  isTerminalTabOnScreen,
  lastHumanTouchAt
} from './idle-keep-guards'

/** Process inspections per tick at most: each may run a process listing in main. */
export const IDLE_AUTO_CLOSE_MAX_INSPECTIONS_PER_TICK = 5

async function inspectPendingShells(
  deps: IdleAutoCloseDeps,
  pending: readonly string[],
  runtimeTerminalsByPtyId: ReadonlyMap<string, RuntimeTerminalSummary>,
  now: number
): Promise<void> {
  for (const ptyId of [...new Set(pending)].slice(0, IDLE_AUTO_CLOSE_MAX_INSPECTIONS_PER_TICK)) {
    let result: ProcessInspection
    try {
      result = await deps.inspectProcess(ptyId)
    } catch {
      result = { foregroundProcess: null, hasChildProcesses: true, unavailable: true }
    }
    rememberInspection(ptyId, result, runtimeTerminalsByPtyId.get(ptyId)?.lastOutputAt ?? null, now)
  }
}

/** Panes whose PTY the daemon or the runtime sees an agent in; remembered past its exit. */
function rememberAgentHeldPanes(
  state: AppState,
  sessionsById: ReadonlyMap<string, PtyListedSession>,
  runtimeTerminalsByPtyId: ReadonlyMap<string, RuntimeTerminalSummary> | null
): void {
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    for (const [leafId, ptyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
      if (
        ptyId &&
        (sessionsById.get(ptyId)?.agentOwnership === 'present' ||
          runtimeTerminalsByPtyId?.get(ptyId)?.agentIdentity)
      ) {
        rememberAgentPane(`${tabId}:${leafId}`)
      }
    }
  }
}

export async function planBareShells(args: {
  deps: IdleAutoCloseDeps
  state: AppState
  now: number
  idleMs: number
  sessionsById: ReadonlyMap<string, PtyListedSession>
  runtimeTerminals: readonly RuntimeTerminalSummary[] | null
}): Promise<IdleDecision[]> {
  const { deps, state, now } = args
  const runtimeTerminalsByPtyId = args.runtimeTerminals
    ? new Map(
        args.runtimeTerminals.flatMap((terminal) =>
          terminal.ptyId && terminal.connected ? [[terminal.ptyId, terminal] as const] : []
        )
      )
    : null
  rememberAgentHeldPanes(state, args.sessionsById, runtimeTerminalsByPtyId)
  const baseInputs = {
    now,
    idleMs: args.idleMs,
    activeWorktreeId: state.activeWorktreeId,
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    nonLocalWorktreeIds: new Set(getNonLocalWorktreeIds(state, Object.keys(state.tabsByWorktree))),
    isOnScreen: isTerminalTabOnScreen,
    foregroundLastSeenAtByTabId: getForegroundTerminalTabLastSeenAtById(),
    lastHumanTouchAt: (tabId: string, paneKeys: string[], ptyIds: string[]) =>
      lastHumanTouchAt({ state, tabId, paneKeys, ptyIds, now }),
    isInterruptedRestorePane: (paneKey: string) =>
      isInterruptedRestoreRecord(state.sleepingAgentSessionsByPaneKey[paneKey]),
    isPinned: (worktreeId: string, tabId: string) =>
      isPinnedTabOrWorkspace(state, worktreeId, tabId),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    heldAgentThisSession: paneHeldAgentThisSession,
    holdsAgentState: (worktreeId: string) => workspaceHoldsAgentState(state, worktreeId),
    launchingTabIds: new Set([
      ...Object.keys(state.pendingStartupByTabId ?? {}),
      ...Object.keys(state.nativeChatLaunchPromptByTabId ?? {}),
      ...Object.keys(state.nativeChatLaunchDraftByTabId ?? {})
    ]),
    lastInputAtByPaneKey: mergePendingTerminalInputActivity(state.lastTerminalInputAtByPaneKey),
    daemonSessionsById: args.sessionsById,
    runtimeTerminalsByPtyId,
    firstObservedAtByPtyId
  }
  const plan = (kept: Parameters<typeof planIdleShellWorkspaces>[0]['kept']) =>
    planIdleShellWorkspaces({
      ...baseInputs,
      kept,
      processByPtyId: runtimeTerminalsByPtyId
        ? currentInspections(runtimeTerminalsByPtyId, now)
        : new Map()
    })
  // Why a first pass with nothing kept: the saved/pinned sidebar read is heavy, so it runs only
  // once some workspace passed every cheap check.
  let result = plan({ paneKeys: new Set(), tabIds: new Set() })
  if (!result.inspect.length && !result.decisions.some((decision) => decision.verdict === 'act')) {
    return result.decisions
  }
  const kept = await deps.readKeptSessions(state)
  result = plan(kept)
  if (result.inspect.length > 0 && runtimeTerminalsByPtyId) {
    await inspectPendingShells(deps, result.inspect, runtimeTerminalsByPtyId, now)
    result = plan(kept)
  }
  return result.decisions
}
