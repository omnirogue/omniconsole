import { useAppStore } from '@/store'
import { buildBriefExecutionPrompt } from '../../../../../shared/assisted-brief-execution-prompt'
import { rebindBriefWorkspace } from '../../../../../shared/assisted-brief-revisions'
import {
  planBriefStart,
  reconcileBriefStarts,
  settleBriefStart,
  type BriefLaunchOutcome,
  type BriefStartPlan,
  type BriefTabProbe
} from '../../../../../shared/assisted-brief-start'
import type { AssistedBriefRecord } from '../../../../../shared/assisted-brief-types'
import type { AttentionLaunchPlan } from '../../../../../shared/attention-launch-favorites'
import { launchAttentionFavorite } from '../attention-favorite-launch'
import { readSavedBrief, writeSavedBrief, type SavedBriefRead } from './assisted-brief-memory'
import type { BriefWorkspace } from './assisted-brief-workspace'

type TabIndex = Record<string, readonly { id: string }[]>

/** Finds a tab by id in any workspace; 'unknown' until the saved session has been restored. */
export function briefTabProbeFrom(sessionReady: boolean, tabsByWorktree: TabIndex): BriefTabProbe {
  return (tabId) => {
    if (!sessionReady) {
      return 'unknown'
    }
    return Object.values(tabsByWorktree).some((tabs) => tabs.some((tab) => tab.id === tabId))
      ? 'present'
      : 'absent'
  }
}

function currentTabProbe(): BriefTabProbe {
  const state = useAppStore.getState()
  return briefTabProbeFrom(state.workspaceSessionReady, state.tabsByWorktree)
}

/** The saved brief, rebound to this workspace and with uncertain starts looked up, never replayed. */
export function readCurrentBrief(
  storage: Storage,
  scope: string,
  workspace: BriefWorkspace
): SavedBriefRead {
  const saved = readSavedBrief(storage, scope, workspace.worktreeId)
  if (!saved.record) {
    return saved
  }
  const now = Date.now()
  const rebound = rebindBriefWorkspace(saved.record, workspace.workspaceKey, now)
  return { record: reconcileBriefStarts(rebound, currentTabProbe(), now), unreadable: false }
}

export type BriefStartResult =
  | { kind: 'started' | 'already-running' | 'uncertain'; record: AssistedBriefRecord }
  | { kind: 'not-started'; record: AssistedBriefRecord }
  | {
      kind: 'refused'
      reason: Extract<BriefStartPlan, { kind: 'refused' }>['reason'] | 'no-brief' | 'save-failed'
    }

function saveBestEffort(
  input: { storage: Storage; scope: string; workspace: BriefWorkspace },
  record: AssistedBriefRecord
): void {
  try {
    writeSavedBrief(input.storage, input.scope, input.workspace.worktreeId, record)
  } catch {
    // Why: the saved in-flight start is looked up again on the next load, so it is never replayed.
  }
}

/**
 * Start approves the current revision, saves the start, then launches the favourite once with
 * the exact approved prompt. Saving first is what keeps double clicks, retries and restarts
 * from launching the same work twice.
 */
export function startApprovedBrief(input: {
  storage: Storage
  scope: string
  workspace: BriefWorkspace
  plan: AttentionLaunchPlan
}): BriefStartResult {
  const { plan, workspace } = input
  const saved = readCurrentBrief(input.storage, input.scope, workspace).record
  if (!saved) {
    return { kind: 'refused', reason: 'no-brief' }
  }
  const probe = currentTabProbe()
  const planned = planBriefStart(saved, {
    workspaceKey: workspace.workspaceKey,
    favoriteId: plan.favorite.id,
    verifiable: !workspace.paired,
    now: Date.now(),
    probe
  })
  if (planned.kind === 'refused') {
    return planned
  }
  try {
    writeSavedBrief(input.storage, input.scope, workspace.worktreeId, planned.record)
  } catch {
    return { kind: 'refused', reason: 'save-failed' }
  }
  if (planned.kind === 'already-running') {
    return { kind: 'already-running', record: planned.record }
  }
  let outcome: BriefLaunchOutcome
  try {
    const launched = launchAttentionFavorite({
      plan,
      worktreeId: workspace.worktreeId,
      request: buildBriefExecutionPrompt(planned.record),
      tabId: planned.start.tabId
    })
    outcome = launched.ok
      ? { ok: true, tabId: launched.tabId }
      : { ok: false, failure: launched.reason }
  } catch {
    // Why: the tab may or may not exist now; look for it rather than launching again.
    const reconciled = reconcileBriefStarts(planned.record, probe, Date.now())
    saveBestEffort(input, reconciled)
    return { kind: 'uncertain', record: reconciled }
  }
  const settled = settleBriefStart(planned.record, planned.start.operationId, outcome, Date.now())
  saveBestEffort(input, settled)
  return { kind: outcome.ok ? 'started' : 'not-started', record: settled }
}
