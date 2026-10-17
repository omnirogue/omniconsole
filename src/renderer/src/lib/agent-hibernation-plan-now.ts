/** Agent sleep's plan from the store as it is now, for the coordinator's tick and its re-checks. */

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  planAgentHibernationCandidates,
  type AgentHibernationCandidate,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'
import { getAllDrivers } from './pane-manager/mobile-driver-state'
import { getForegroundTerminalTabLastSeenAtById } from './foreground-terminal-tabs'
import {
  applyDaemonSessionIdentities,
  getHibernationBoundaryResolvedAtByPaneKey,
  getHibernationPaneTouchStamps,
  getHibernationPtyBindingFirstSeenAtByPaneKey,
  needsDaemonSessionIdentities,
  observeHibernationPtyBindings,
  persistHibernationPaneTouches,
  type DaemonSessionIdentity,
  type HibernationPaneTouches
} from './agent-hibernation-pane-age'
import { mergePendingTerminalInputActivity } from './terminal-input-activity-coalescing'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import {
  collectRuntimePtyLiveness,
  runtimeWorktreesHeldBack,
  type RuntimePtyLivenessSample
} from './agent-hibernation-runtime-liveness'
import { plannerSettingsFor, type AgentSleepPolicy } from './agent-sleep-policy'
import { getEntryTabId } from './agent-hibernation-pane-eligibility'
import { getOnScreenTerminalTabIds } from './idle-auto-close/idle-keep-guards'
import { reviewWaitIdleMsByPaneKey } from './review-sleep-targets'

type DaemonSessionReader = () => Promise<readonly DaemonSessionIdentity[] | null>

/** A listing that has not answered by then counts as failed: every carried stamp starts fresh. */
export const DAEMON_SESSION_LISTING_TIMEOUT_MS = 10_000

/** The local daemon's live sessions with their lifetimes; null when they could not be read. */
async function readDaemonSessionIdentities(): Promise<readonly DaemonSessionIdentity[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const listing = await Promise.race([
      window.api.pty.management.listSessions(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DAEMON_SESSION_LISTING_TIMEOUT_MS)
      })
    ])
    return listing
      ? listing.sessions.map((session) => ({
          sessionId: session.sessionId,
          incarnationId: session.incarnationId ?? null,
          pid: session.pid
        }))
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

let daemonSessionReader: DaemonSessionReader = readDaemonSessionIdentities

export function setDaemonSessionReaderForTests(reader: DaemonSessionReader | null): void {
  daemonSessionReader = reader ?? readDaemonSessionIdentities
}

function allTabIds(tabsByWorktree: AppState['tabsByWorktree']): string[] {
  return Object.values(tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
}

/** The newer of two stamps per key. */
function newestStamps(
  live: Record<string, number | undefined>,
  carried: Record<string, number>
): Record<string, number | undefined> {
  const out = { ...live }
  for (const [key, at] of Object.entries(carried)) {
    if (at > (out[key] ?? 0)) {
      out[key] = at
    }
  }
  return out
}

/** The window's touch stamps as they are now: keystrokes (pending ones too) and tab reveals. */
function liveTouches(state: AppState): HibernationPaneTouches {
  return {
    // Why: input stamps are coalesced, so planning must see the not-yet-flushed keystroke.
    inputAtByPaneKey: mergePendingTerminalInputActivity(state.lastTerminalInputAtByPaneKey),
    revealAtByTabId: getForegroundTerminalTabLastSeenAtById(),
    sleptPaneKeys: new Set(
      Object.entries(state.sleepingAgentSessionsByPaneKey)
        .filter(([, record]) => record?.origin === 'worktree-sleep' && record.state === 'done')
        .map(([paneKey]) => paneKey)
    )
  }
}

/** For the window going away: saves the touches the last tick has not seen yet. */
export function persistHibernationPaneTouchesNow(): void {
  persistHibernationPaneTouches(liveTouches(useAppStore.getState()))
}

function snapshotFromState(
  state: AppState,
  now: number,
  runtimeLiveness: RuntimePtyLivenessSample,
  policy: AgentSleepPolicy,
  touches: HibernationPaneTouches,
  targetWorktreeId?: string
): AgentHibernationPlannerSnapshot {
  const tabsByWorktree = targetWorktreeId
    ? { [targetWorktreeId]: state.tabsByWorktree[targetWorktreeId] ?? [] }
    : state.tabsByWorktree
  const carried = getHibernationPaneTouchStamps()
  return {
    settings: plannerSettingsFor(policy),
    activeWorktreeId: state.activeWorktreeId,
    // Why the panes' own visibility too: G3 and the exit handler's wake read the same ref.
    foregroundTerminalTabIds: getOnScreenTerminalTabIds(allTabIds(tabsByWorktree)),
    tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimeLivePtyIdsByWorktreeId: runtimeLiveness.runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: runtimeLiveness.runtimeLivenessRequiredWorktreeIds,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
    // Why the carried stamps too: a draft typed or a tab revealed before an app restart must
    // still hold the pane after it, now that the restart no longer resets its idle clock.
    lastTerminalInputAtByPaneKey: newestStamps(touches.inputAtByPaneKey, carried.inputAtByPaneKey),
    foregroundTerminalLastSeenAtByTabId: newestStamps(
      touches.revealAtByTabId,
      carried.revealAtByTabId
    ),
    ptyBindingFirstSeenAtByPaneKey: getHibernationPtyBindingFirstSeenAtByPaneKey(),
    boundaryResolvedAtByPaneKey: getHibernationBoundaryResolvedAtByPaneKey(),
    reviewWaitIdleMsByPaneKey: reviewWaitIdleMsByPaneKey(),
    now
  }
}

function observeBindings(
  state: AppState,
  now: number,
  policy: AgentSleepPolicy
): HibernationPaneTouches {
  const touches = liveTouches(state)
  observeHibernationPtyBindings({
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    now,
    idleMs: policy.idleMs,
    touches
  })
  return touches
}

export async function currentCandidates(
  now: number,
  policy: AgentSleepPolicy,
  targetWorktreeId?: string
): Promise<AgentHibernationCandidate[]> {
  // Why: only the opt-in hibernation sleeps runtime-environment panes; the idle rules (shadow by
  // default, for everyone) must not list remote runtimes every minute, so they skip them.
  const runtimeLiveness =
    policy.source === 'hibernation'
      ? await collectRuntimePtyLiveness(useAppStore.getState(), targetWorktreeId)
      : runtimeWorktreesHeldBack(useAppStore.getState(), targetWorktreeId)
  let freshState = useAppStore.getState()
  // Why: age the PTY bindings from the same state the plan is built from, so a pane
  // observed for the first time this pass cannot also be judged long-idle in it.
  let touches = observeBindings(freshState, now, policy)
  // Why: a pane seen again after an app restart keeps its previous run's clock only once the
  // daemon shows the same PTY lifetime; a cold restore reuses the id for a new process.
  if (needsDaemonSessionIdentities()) {
    applyDaemonSessionIdentities(await daemonSessionReader().catch(() => null))
    freshState = useAppStore.getState()
    touches = observeBindings(freshState, now, policy)
  }
  return planAgentHibernationCandidates(
    snapshotFromState(freshState, now, runtimeLiveness, policy, touches, targetWorktreeId)
  ).filter((candidate) => {
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
      freshState,
      candidate.worktreeId
    )
    return !runtimeEnvironmentId || candidate.expectedRuntimePtyIds.length === 1
  })
  // Why no output check: idleness is a finished turn plus no input. A finished TUI that keeps
  // repainting (Grok's MCP spinner, status lines) changed the output signature between every pair
  // of ticks, so it could never be confirmed and never slept (#857).
}

/** G3, counted: done agents the planner left alone because their tab is on screen. */
export function countOnScreenDoneAgents(state: AppState): number {
  const onScreen = new Set(getOnScreenTerminalTabIds(allTabIds(state.tabsByWorktree)))
  let count = 0
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    const tabId = entry?.state === 'done' ? getEntryTabId(entry) : null
    if (tabId && onScreen.has(tabId)) {
      count += 1
    }
  }
  return count
}
