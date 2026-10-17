import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useWaitingUntil } from '@/store/wait-later-store'
import { useMinuteTick } from '@/lib/conversation-retention'
import { useSessionChainRows } from '@/lib/session-chain-runner'
import { useWaitingPaneTimes } from '@/lib/session-snooze'
import { buildSessionSidebarTreeRows } from '@/lib/session-sidebar-tree-rows'
import { sessionStatistics } from '@/lib/session-statistics'
import type { SessionDataSnapshot } from '@/lib/session-data-snapshot-store'
import { useAgentPaneSnapshot } from '../attention/use-agent-pane-snapshot'
import { useSessionSidebarTreeSnapshot } from '@/lib/session-sidebar-tree-snapshot'
import {
  useSidebarSessions,
  useSessionOwnerArchiveKeys
} from '../sidebar/session-folders/use-sidebar-sessions'
import { useSessionSidebarLoad } from '../sidebar/session-folders/use-session-sidebar-load'
import { useSessionSidebarPaneMarks } from '../sidebar/session-folders/use-session-sidebar-pane-marks'
import {
  useSessionChainByRowKey,
  sessionChainRowsByRowKey
} from '../sidebar/session-folders/use-session-chain-by-row-key'

export type SessionStatisticsData = ReturnType<typeof sessionStatistics>

/** Reads the existing pushed inventory and shared activity snapshot; no new data poll. */
export function useSessionStatisticsSnapshot(): SessionDataSnapshot<SessionStatisticsData> {
  const sessions = useSidebarSessions('pane')
  const archivedKeys = useSessionOwnerArchiveKeys(sessions)
  const folders = useSessionFolders()
  const viewStore = useSessionSidebarView()
  const batchOrigins = useSessionSidebarLoad(folders, viewStore)
  const snapshot = useSessionSidebarTreeSnapshot(useAgentPaneSnapshot())
  const paneMarks = useSessionSidebarPaneMarks()
  const waitingUntilByPaneKey = useWaitingPaneTimes(useWaitingUntil())
  const chainRows = useSessionChainRows()
  const chainByRowKey = useSessionChainByRowKey(chainRows)
  const now = useMinuteTick(viewStore.view.snoozedUntil)
  const hydrated = useAppStore((state) => state.runtimeEnvironmentCatalogHydrated)
  const settled = useAppStore((state) => state.runtimeEnvironmentCatalogSettled)
  const inventoryReady = useAppStore((state) => state.workspaceSessionReady)
  return useMemo(() => {
    const built = buildSessionSidebarTreeRows(
      {
        sessions,
        archivedKeys,
        metadata: folders.metadata,
        view: viewStore.view,
        snapshot,
        query: '',
        showHidden: true,
        waitingUntilByPaneKey,
        batchOrigins,
        chainByRowKey,
        chainsByRowKey: sessionChainRowsByRowKey(chainRows, chainByRowKey),
        ...paneMarks
      },
      now
    )
    const data = sessionStatistics(built.rows, now, built.classifications)
    const issue = (settled && !hydrated) || folders.error ? 'unavailable' : null
    const loading = !inventoryReady || !settled || !folders.loaded || !viewStore.loaded
    return {
      data,
      issue,
      status: issue ?? (loading ? 'loading' : data.total.total ? 'healthy' : 'healthy-empty'),
      error: folders.error,
      readAt: now,
      lastSuccessAt: issue || loading ? null : now
    }
  }, [
    sessions,
    archivedKeys,
    folders.metadata,
    folders.error,
    folders.loaded,
    viewStore.view,
    viewStore.loaded,
    snapshot,
    waitingUntilByPaneKey,
    batchOrigins,
    chainRows,
    chainByRowKey,
    paneMarks,
    now,
    hydrated,
    settled,
    inventoryReady
  ])
}
