import type { AppState } from '@/store/types'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useRoutineSessionCatalog } from '@/components/sidebar/routines/routine-session-catalog'
import { useRoutineConversations } from '@/components/sidebar/routines/routine-conversation-state'
import {
  automaticSessionCleanupKeep,
  normalizeAutomaticSessionCleanupProtection,
  type CleanupKeepReason
} from '../../../shared/automatic-session-cleanup-protection'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import { workspaceFacts } from './session-manage-row-facts'
import { getShownChains } from './session-chain-registry'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'

export type AutomaticCleanupTarget = { worktreeId: string; tabId: string; paneKey: string }

/** A session's own review publish is the explicit contract that lifts only the started-today hold. */
export type AutomaticCleanupProtectionOptions = { ignoreStartedToday?: boolean }

type CachedSidebarRowsByTarget = {
  state: AppState
  tabsByWorktree: AppState['tabsByWorktree']
  worktreesByRepo: AppState['worktreesByRepo']
  folderWorkspaces: AppState['folderWorkspaces']
  metadata: ReturnType<typeof useSessionFolders.getState>['metadata']
  view: ReturnType<typeof useSessionSidebarView.getState>['view']
  archived: ReturnType<typeof useSessionSidebarView.getState>['archived']
  routineOwners: ReturnType<typeof useRoutineSessionCatalog.getState>['owners']
  legacyRoutines: ReturnType<typeof useRoutineConversations.getState>['byRoutine']
  chains: ReturnType<typeof getShownChains>
  now: number
  byTargetKey: Map<string, SessionManageSidebarRow>
}

let cachedRowsByTarget: CachedSidebarRowsByTarget | null = null

function targetLookupKey(worktreeId: string, tabId: string | null, paneKey: string | null): string {
  return `${worktreeId}\0${tabId ?? ''}\0${paneKey ?? ''}`
}

function findTargetSidebarRow(
  state: AppState,
  target: AutomaticCleanupTarget,
  now: number
): SessionManageSidebarRow | undefined {
  const { metadata } = useSessionFolders.getState()
  const { view, archived } = useSessionSidebarView.getState()
  const { owners: routineOwners } = useRoutineSessionCatalog.getState()
  // Why every builder input: a hit must answer exactly as a fresh full scan would.
  const { byRoutine: legacyRoutines } = useRoutineConversations.getState()
  const chains = getShownChains()
  if (
    !cachedRowsByTarget ||
    cachedRowsByTarget.state !== state ||
    cachedRowsByTarget.tabsByWorktree !== state.tabsByWorktree ||
    cachedRowsByTarget.worktreesByRepo !== state.worktreesByRepo ||
    cachedRowsByTarget.folderWorkspaces !== state.folderWorkspaces ||
    cachedRowsByTarget.metadata !== metadata ||
    cachedRowsByTarget.view !== view ||
    cachedRowsByTarget.archived !== archived ||
    cachedRowsByTarget.routineOwners !== routineOwners ||
    cachedRowsByTarget.legacyRoutines !== legacyRoutines ||
    cachedRowsByTarget.chains !== chains ||
    cachedRowsByTarget.now !== now
  ) {
    const byTargetKey = new Map<string, SessionManageSidebarRow>()
    for (const row of buildSessionManageSidebarRows(state, now)) {
      const key =
        row.tabId && row.paneKey ? targetLookupKey(row.worktreeId, row.tabId, row.paneKey) : null
      // Why first wins: the full scan this replaces answered with the first matching row.
      if (key && !byTargetKey.has(key)) {
        byTargetKey.set(key, row)
      }
    }
    cachedRowsByTarget = {
      state,
      tabsByWorktree: state.tabsByWorktree,
      worktreesByRepo: state.worktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      metadata,
      view,
      archived,
      routineOwners,
      legacyRoutines,
      chains,
      now,
      byTargetKey
    }
  }
  return cachedRowsByTarget.byTargetKey.get(
    targetLookupKey(target.worktreeId, target.tabId, target.paneKey)
  )
}

function protectionConfig(state: AppState, options: AutomaticCleanupProtectionOptions | undefined) {
  const configured = state.settings?.automaticSessionCleanupProtection
  const normalized = options?.ignoreStartedToday
    ? normalizeAutomaticSessionCleanupProtection(configured)
    : null
  return normalized ? { ...normalized, protectStartedToday: false } : configured
}

/** The same owner-local facts the sidebar publishes, with explicit catalog read coverage. */
export function automaticCleanupProtectionForRow(
  state: AppState,
  row: SessionManageSidebarRow,
  now: number,
  options?: AutomaticCleanupProtectionOptions
): CleanupKeepReason | null {
  if (
    row.hostId !== 'local' ||
    row.hostUnavailable ||
    getExecutionHostIdForWorktree(state, row.worktreeId) !== 'local' ||
    getRuntimeEnvironmentIdForWorktree(state, row.worktreeId) !== null
  ) {
    return 'protection-unknown'
  }
  const tab = (state.tabsByWorktree[row.worktreeId] ?? []).find((tab) => tab.id === row.tabId)
  const catalogReady = useRoutineSessionCatalog.getState().coverageByTarget.local === 'ready'
  const worktreePath = workspaceFacts(state, row.worktreeId).worktreePath ?? row.worktreePath
  return automaticSessionCleanupKeep({
    config: protectionConfig(state, options),
    target: {
      worktreePath,
      paneKey: row.paneKey,
      createdAt: tab?.createdAt ?? null
    },
    facts: {
      routine: row.routine === true ? true : catalogReady ? (row.routine ?? null) : null,
      pinned: row.pinned,
      saved: useSessionFolders.getState().loaded ? row.saved : null
    },
    now
  })
}

/** Re-read before and after async process checks; missing rows never permit a stop. */
export function readAutomaticCleanupProtection(
  state: AppState,
  target: AutomaticCleanupTarget,
  now: number,
  options?: AutomaticCleanupProtectionOptions
): CleanupKeepReason | null {
  if (
    !normalizeAutomaticSessionCleanupProtection(state.settings?.automaticSessionCleanupProtection)
  ) {
    return 'protection-unconfigured'
  }
  try {
    const row = findTargetSidebarRow(state, target, now)
    return row ? automaticCleanupProtectionForRow(state, row, now, options) : 'protection-unknown'
  } catch {
    return 'protection-unknown'
  }
}
