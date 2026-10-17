import { useSessionSelection } from '@/store/session-selection'
import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import {
  buildPaneSessions,
  buildSidebarSessions,
  type SidebarSession
} from '@/lib/sidebar-sessions'
import {
  applyPendingFolderLaunches,
  hasPendingFolderLaunches,
  subscribePendingFolderLaunches
} from '@/lib/pending-folder-launches'
import { migrateSessionOrganizationKeys } from '@/lib/session-organization-key-migration'
import { sessionOrganizationOwnershipMigration } from '@/lib/session-organization-ownership'
import { useSessionBatchOrigins } from '@/store/session-batch-origins'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useShownSessionChains } from '@/lib/session-chain-registry'
import { shareSidebarSessions } from '@/lib/session-sidebar-structural-sharing'
import { selectSidebarSessionStatus } from '@/lib/sidebar-session-status-projection'
import { sessionOwnerArchiveKeys } from '@/lib/session-owner-archive-keys'
import { mirroredWorkflowOwnerArchivedKeys } from '@/lib/mirrored-workflow-rows'

export function useSessionOwnerArchiveKeys(sessions: readonly SidebarSession[]): Set<string> {
  const localArchive = useSessionSidebarView((state) => state.archived)
  const archived = useSidebarArchivedKeys(localArchive)
  return useMemo(() => sessionOwnerArchiveKeys([...archived], sessions), [archived, sessions])
}

export function useSidebarSessions(projection: 'sidebar' | 'pane' = 'sidebar'): SidebarSession[] {
  const outcomeChains = useShownSessionChains()
  const source = useAppStore(
    useShallow((state) => ({
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      sshConnectionStates: state.sshConnectionStates,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      tabsByWorktree: state.tabsByWorktree,
      unifiedTabsByWorktree: state.unifiedTabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      // Why: a status ping republishes this whole map many times a minute, but the row list
      // reads only which panes exist and how they are named — see the projection.
      agentStatusByPaneKey: selectSidebarSessionStatus(state.agentStatusByPaneKey),
      sleepingAgentSessionsByPaneKey: state.sleepingAgentSessionsByPaneKey,
      pendingStartupByTabId: state.pendingStartupByTabId,
      automaticAgentResumeClaimsByTabId: state.automaticAgentResumeClaimsByTabId,
      // Why: workflow rows show their pushed run state, not a permanent "queued".
      localWorkflowStatusByTabId: state.localWorkflowStatusByTabId,
      // Why: a run that was not found, or could not be read, says so instead of waiting forever.
      localWorkflowHydrationByTabId: state.localWorkflowHydrationByTabId,
      buildReview: state.buildReview,
      // Why: a paired computer's workflow conversations count under it (session counts, step 9).
      mirroredWorkflowRecordsByOwner: state.mirroredWorkflowRecordsByOwner,
      // Why (C2): a ledger event alone changes rows — membership, rest, archive and placement —
      // and the owner's mirror tabs are found through the paired-environment catalog (F8).
      mirroredConversationLedgerByOwner: state.mirroredConversationLedgerByOwner,
      mirroredConversationOwnersByEnvironment: state.mirroredConversationOwnersByEnvironment,
      ptyIdsByTabId: state.ptyIdsByTabId,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
      removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds
    }))
  )
  const previous = useRef<SidebarSession[]>([])
  // Why: a status ping rebuilds every session; returning the previous array when no row's
  // identity-bearing fields changed keeps the tree and every memoized row from re-rendering.
  const sessions = useMemo(
    () =>
      shareSidebarSessions(
        previous.current,
        (projection === 'pane' ? buildPaneSessions : buildSidebarSessions)(source, outcomeChains)
      ),
    [source, outcomeChains, projection]
  )
  useEffect(() => {
    previous.current = sessions
  }, [sessions])
  useEffect(
    () =>
      subscribePendingFolderLaunches(() =>
        applyPendingFolderLaunches(previous.current, useSessionFolders.getState(), tabAliases)
      ),
    []
  )
  // Why: the instant a terminal pane's provider session becomes known, fold
  // its provisional folder membership onto the durable provider key so the
  // conversation never drops out of its folder (see session-folder-identity.ts).
  useEffect(() => {
    for (const session of sessions) {
      if (session.folderKeyMigration) {
        const { from, to } = session.folderKeyMigration
        const selection = useSessionSelection.getState()
        if (selection.selected.has(from)) {
          selection.set(selection.keys.map((key) => (key === from ? to : key)))
        }
      }
    }
    migrateSessionOrganizationKeys(sessions, {
      folders: useSessionFolders,
      view: useSessionSidebarView,
      origins: useSessionBatchOrigins,
      ownership: sessionOrganizationOwnershipMigration
    })
    // Why: a conversation started from a folder's "+" joins that folder once its row has an identity.
    if (hasPendingFolderLaunches()) {
      applyPendingFolderLaunches(sessions, useSessionFolders.getState(), tabAliases)
    }
  }, [sessions])
  return sessions
}

/**
 * The list's archive marks: this computer's own, plus mirrored workflow conversations their
 * controller archived (the record's archive reference, step 9), so a paired computer's Archived
 * count holds the same workflows as the controller's own.
 */
export function useSidebarArchivedKeys(archived: readonly string[]): Set<string> {
  const ownerArchived = useAppStore(
    useShallow((state) => mirroredWorkflowOwnerArchivedKeys(state.mirroredWorkflowRecordsByOwner))
  )
  return useMemo(() => new Set([...archived, ...ownerArchived]), [archived, ownerArchived])
}

/** A unified tab and the terminal or session entity it shows are the same conversation. */
function tabAliases(tabId: string): string[] {
  for (const tabs of Object.values(useAppStore.getState().unifiedTabsByWorktree)) {
    const tab = tabs.find((entry) => entry.id === tabId || entry.entityId === tabId)
    if (tab) {
      return [tab.id, tab.entityId]
    }
  }
  return [tabId]
}
