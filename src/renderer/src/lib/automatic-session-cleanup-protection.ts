import type { AppState } from '@/store/types'
import { useSessionFolders } from '@/store/session-folders'
import { useRoutineSessionCatalog } from '@/components/sidebar/routines/routine-session-catalog'
import {
  automaticSessionCleanupKeep,
  normalizeAutomaticSessionCleanupProtection,
  type CleanupKeepReason
} from '../../../shared/automatic-session-cleanup-protection'
import type { SessionManageSidebarRow } from '../../../shared/session-manage-relay'
import { buildSessionManageSidebarRows } from './session-manage-sidebar-rows'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from './worktree-runtime-owner'

export type AutomaticCleanupTarget = { worktreeId: string; tabId: string; paneKey: string }

/** A session's own review publish is the explicit contract that lifts only the started-today hold. */
export type AutomaticCleanupProtectionOptions = { ignoreStartedToday?: boolean }

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
  return automaticSessionCleanupKeep({
    config: protectionConfig(state, options),
    target: {
      worktreePath: row.worktreePath,
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
    const row = buildSessionManageSidebarRows(state, now).find(
      (row) =>
        row.worktreeId === target.worktreeId &&
        row.tabId === target.tabId &&
        row.paneKey === target.paneKey
    )
    return row ? automaticCleanupProtectionForRow(state, row, now, options) : 'protection-unknown'
  } catch {
    return 'protection-unknown'
  }
}
