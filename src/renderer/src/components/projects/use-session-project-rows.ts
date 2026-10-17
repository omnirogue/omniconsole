import { useMemo, useRef } from 'react'
import { useAgentPaneSnapshot } from '@/components/attention/use-agent-pane-snapshot'
import { useRoutineOwners } from '@/components/sidebar/routines/use-routine-owners'
import { rememberFirstSeen } from '@/components/sidebar/session-folders/session-first-seen'
import {
  sessionChainRowsByRowKey,
  useSessionChainByRowKey
} from '@/components/sidebar/session-folders/use-session-chain-by-row-key'
import { useSessionSidebarLoad } from '@/components/sidebar/session-folders/use-session-sidebar-load'
import { useSessionSidebarPaneMarks } from '@/components/sidebar/session-folders/use-session-sidebar-pane-marks'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { useMinuteTick } from '@/lib/conversation-retention'
import { useSessionChainRows, type SessionChainRowInfo } from '@/lib/session-chain-runner'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import type { WorkerLineageActionIdentity } from '../../../../shared/worker-lineage'
import { createSessionSidebarRowCache } from '@/lib/session-sidebar-row-cache'
import {
  buildSessionSidebarTreeRows,
  type PursuitSidebarTreeRow
} from '@/lib/session-sidebar-tree-rows'
import { useSessionSidebarTreeSnapshot } from '@/lib/session-sidebar-tree-snapshot'
import { useWaitingPaneTimes } from '@/lib/session-snooze'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useWaitingUntil } from '@/store/wait-later-store'

export type SessionProjectRows = {
  rows: PursuitSidebarTreeRow[]
  classifications: ReadonlyMap<string, string>
  workerParentByLeaf: ReadonlyMap<string, string>
  workerDispatchByLeaf: ReadonlyMap<string, WorkerLineageActionIdentity>
  workerSubagentLeaves?: ReadonlySet<string>
  chainsByRowKey: ReadonlyMap<string, SessionChainRowInfo>
  metadata: SessionFolderMetadata
  now: number
}

/**
 * Every conversation as the classified row the Conversations sidebar would show, before any
 * lens, host scope, tag or agent filter: the Projects view cuts the list by project itself.
 */
export function useSessionProjectRows(): SessionProjectRows {
  const routineOwners = useRoutineOwners()
  const viewStore = useSessionSidebarView()
  const now = useMinuteTick(viewStore.view.snoozedUntil)
  const paneMarks = useSessionSidebarPaneMarks()
  const folders = useSessionFolders()
  const archivedKeys = useMemo(() => new Set(viewStore.archived), [viewStore.archived])
  const sessions = useSidebarSessions()
  const waitingUntil = useWaitingUntil()
  const waitingUntilByPaneKey = useWaitingPaneTimes(waitingUntil)
  const snapshot = useSessionSidebarTreeSnapshot(useAgentPaneSnapshot())
  const chainRows = useSessionChainRows()
  const chainByRowKey = useSessionChainByRowKey(chainRows)
  const chainsByRowKey = useMemo(
    () => sessionChainRowsByRowKey(chainRows, chainByRowKey),
    [chainRows, chainByRowKey]
  )
  const batchOrigins = useSessionSidebarLoad(folders, viewStore)
  const rowCache = useRef(createSessionSidebarRowCache()).current
  const built = useMemo(
    () =>
      buildSessionSidebarTreeRows(
        {
          routineOwners,
          rowCache,
          now,
          showArchived: true,
          chainsByRowKey,
          chainByRowKey,
          ...paneMarks,
          firstSeenByRowKey: rememberFirstSeen(sessions, now),
          waitingUntilByPaneKey,
          waitingUntilByRowKey: waitingUntil,
          sessions,
          metadata: folders.metadata,
          view: viewStore.view,
          archivedKeys,
          snapshot,
          query: '',
          showHidden: true,
          batchOrigins
        },
        now
      ),
    [
      routineOwners,
      rowCache,
      now,
      chainsByRowKey,
      chainByRowKey,
      paneMarks,
      sessions,
      waitingUntilByPaneKey,
      waitingUntil,
      folders.metadata,
      viewStore.view,
      archivedKeys,
      snapshot,
      batchOrigins
    ]
  )
  return useMemo(
    () => ({
      rows: built.rows,
      classifications: built.classifications,
      workerParentByLeaf: paneMarks.workerParentByLeaf,
      workerDispatchByLeaf: paneMarks.workerDispatchByLeaf,
      workerSubagentLeaves: paneMarks.workerSubagentLeaves,
      chainsByRowKey,
      metadata: folders.metadata,
      now
    }),
    [
      built,
      paneMarks.workerParentByLeaf,
      paneMarks.workerDispatchByLeaf,
      paneMarks.workerSubagentLeaves,
      chainsByRowKey,
      folders.metadata,
      now
    ]
  )
}
