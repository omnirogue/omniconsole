import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getShownChains, useShownSessionChains } from '@/lib/session-chain-registry'
import { isFinishedPane, waitLaterKeyForPane } from '@/lib/wait-later'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useFinishedMarks, useWaitLater, useWaitingKeys } from '@/store/wait-later-store'
import { buildAgentPaneSnapshot, type AgentPaneSnapshot } from './agent-pane-snapshot'
import { withRunAttention } from './run-attention-panes'
import {
  useCurrentReplyDecisions,
  usePendingNextSteps
} from '../next-steps/next-steps-pending-store'
import { withReplyDecisionAttention } from './reply-decision-attention'
import { registerClosedSidebarAttentionReader } from '../sidebar/closed-sidebar-attention'

export type AgentPaneSnapshotInputs = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'folderWorkspaces'
  | 'acknowledgedAgentsByPaneKey'
  | 'settings'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
  | 'runtimeEnvironmentCatalogHydrated'
> & { agentStatusEpoch: number }

const EMPTY_LIST: never[] = []
const EMPTY_RECORD: Record<string, never> = Object.freeze({})
const EMPTY_MAP: AppState['runtimeStatusByEnvironmentId'] = new Map()

// Why the defaults: partial store mocks and early boot frames omit slices; the projection must stay callable.
export function selectAgentPaneSnapshotInputs(state: Partial<AppState>): AgentPaneSnapshotInputs {
  return {
    repos: state.repos ?? EMPTY_LIST,
    worktreesByRepo: state.worktreesByRepo ?? EMPTY_RECORD,
    tabsByWorktree: state.tabsByWorktree ?? EMPTY_RECORD,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree ?? EMPTY_RECORD,
    agentStatusByPaneKey: state.agentStatusByPaneKey ?? EMPTY_RECORD,
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey ?? EMPTY_RECORD,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId ?? EMPTY_RECORD,
    runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_RECORD,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? EMPTY_RECORD,
    ptyIdsByTabId: state.ptyIdsByTabId ?? EMPTY_RECORD,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId ?? EMPTY_RECORD,
    folderWorkspaces: state.folderWorkspaces ?? EMPTY_LIST,
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey ?? EMPTY_RECORD,
    settings: state.settings ?? null,
    runtimeEnvironments: state.runtimeEnvironments ?? EMPTY_LIST,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId ?? EMPTY_MAP,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated ?? false,
    agentStatusEpoch: state.agentStatusEpoch ?? 0
  }
}

let cache: { inputs: AgentPaneSnapshotInputs; snapshot: AgentPaneSnapshot } | null = null

function sameInputs(left: AgentPaneSnapshotInputs, right: AgentPaneSnapshotInputs): boolean {
  for (const key of Object.keys(left) as (keyof AgentPaneSnapshotInputs)[]) {
    if (!Object.is(left[key], right[key])) {
      return false
    }
  }
  return true
}

/** Memoised across every subscriber so the nav badge, both sidebars and the attention page share one projection. */
export function selectAgentPaneSnapshot(inputs: AgentPaneSnapshotInputs): AgentPaneSnapshot {
  if (cache && sameInputs(cache.inputs, inputs)) {
    return cache.snapshot
  }
  // Why: Date.now() is read here (not a dep) so idle decay tracks agentStatusEpoch ticks, matching the dashboard.
  const snapshot = buildAgentPaneSnapshot(inputs, Date.now())
  cache = { inputs, snapshot }
  return snapshot
}

export function resetAgentPaneSnapshotCacheForTest(): void {
  cache = null
}

/**
 * A pane the person asked to wait on is not "needs you" until its time passes, and one
 * they called finished stays out until it asks again after that; their cards stay.
 */
export function withoutWaitingPanes(
  snapshot: AgentPaneSnapshot,
  waiting: ReadonlySet<string>,
  finished: ReadonlyMap<string, number> = new Map()
): AgentPaneSnapshot {
  if ((waiting.size === 0 && finished.size === 0) || snapshot.attention.length === 0) {
    return snapshot
  }
  const attention = snapshot.attention.filter((pane) => {
    const key = waitLaterKeyForPane(pane.paneKey)
    return !waiting.has(key) && !isFinishedPane(finished, key, pane.stateChangedAt)
  })
  if (attention.length === snapshot.attention.length) {
    return snapshot
  }
  return {
    ...snapshot,
    attention,
    attentionByPaneKey: new Map(attention.map((pane) => [pane.paneKey, pane])),
    attentionWorktreeIds: new Set(attention.map((pane) => pane.worktreeId))
  }
}

export function useAgentPaneSnapshot(): AgentPaneSnapshot {
  const inputs = useAppStore(useShallow(selectAgentPaneSnapshotInputs))
  const waiting = useWaitingKeys()
  const finished = useFinishedMarks()
  const chains = useShownSessionChains()
  const decisions = useCurrentReplyDecisions()
  // Why after the put-away filter: ✓ Done on a pane answers that pane's prompt, never a run's
  // request; only the requirement being met closes one, so a request is snoozed and nothing else.
  return useMemo(
    () =>
      withRunAttention(
        withoutWaitingPanes(
          withReplyDecisionAttention(selectAgentPaneSnapshot(inputs), decisions, inputs),
          waiting,
          finished
        ),
        chains,
        waiting
      ),
    [chains, decisions, finished, inputs, waiting]
  )
}

/**
 * The same snapshot useAgentPaneSnapshot builds, read straight from the stores for callers
 * outside React (the closed-sidebar Cmd+1–9 order), so both see the same attention.
 */
export function readAgentPaneSnapshot(state: Partial<AppState>): AgentPaneSnapshot {
  const inputs = selectAgentPaneSnapshotInputs(state)
  const { waiting, finished } = useWaitLater.getState()
  const pending = usePendingNextSteps.getState()
  const decisions = [
    ...(pending.unknown || pending.revision === null ? [] : (pending.replyDecisions ?? [])),
    ...(pending.remoteReplyDecisions ?? [])
  ]
  return withRunAttention(
    withoutWaitingPanes(
      withReplyDecisionAttention(selectAgentPaneSnapshot(inputs), decisions, inputs),
      waiting,
      finished
    ),
    getShownChains(),
    waiting
  )
}

registerClosedSidebarAttentionReader((state) => readAgentPaneSnapshot(state).attentionWorktreeIds)
