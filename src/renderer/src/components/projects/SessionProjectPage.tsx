import React, { useEffect, useMemo, useState } from 'react'
import { WorkDispatchComposer } from '@/components/work/WorkDispatchComposer'
import type { SessionFolder } from '@/lib/session-folders'
import { projectSettingsFor } from '@/lib/session-folders'
import { cn } from '@/lib/utils'
import {
  countSessionProjectThreadGroups,
  groupSessionProjectThreads,
  searchSessionProjectThreads,
  sortSessionProjectThreads
} from '@/lib/session-project-thread-groups'
import { filterSessionProjectThreads, sessionProjectThreads } from '@/lib/session-project-threads'
import {
  isSessionProjectViewFiltered,
  readSessionProjectViewState,
  saveSessionProjectViewState,
  sessionProjectViewFilter,
  type SessionProjectViewState
} from '@/lib/session-project-view-state'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionTasks } from '@/store/session-task-store'
import { sessionFolderChain } from '../../../../shared/session-project-folder'
import { canShowSessionTerminal } from '../session-grid/use-session-grid-portals'
import { SessionProjectChatPane } from './SessionProjectChatPane'
import { SessionProjectContextChips } from './SessionProjectContextChips'
import { SessionProjectFilterBar } from './SessionProjectFilterBar'
import { SessionProjectHeader } from './SessionProjectHeader'
import { SessionProjectLibrary } from './SessionProjectLibrary'
import { SessionProjectMultiThreadLauncher } from './SessionProjectMultiThreadLauncher'
import { SessionProjectRoutines } from './SessionProjectRoutines'
import { useProjectSessionDrop } from './use-project-session-drop'
import { useProjectReviewLaunch } from './use-project-review-launch'
import { SessionProjectThreadList } from './SessionProjectThreadList'
import type { SessionProjectRows } from './use-session-project-rows'
import { useSessionHostedReviewOpen } from './use-session-project-review'

/** One project: its context, a composer that files new threads in it, and its threads by state. */
export function SessionProjectPage({
  folder,
  data
}: {
  folder: SessionFolder
  data: SessionProjectRows
}): React.JSX.Element {
  const settings = useSessionFolders((state) => projectSettingsFor(state.metadata, folder.id))
  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)
  const orchestrationByPaneKey = useAppStore((state) => state.runtimeAgentOrchestrationByPaneKey)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const taskLinkByPaneKey = useSessionTasks((state) => state.links)
  const loadTaskLinks = useSessionTasks((state) => state.load)
  useEffect(() => loadTaskLinks(), [loadTaskLinks])
  const hostedReviewOpen = useSessionHostedReviewOpen()
  const [view, setView] = useState<SessionProjectViewState>(() =>
    readSessionProjectViewState(folder.id)
  )
  const updateView = (patch: Partial<SessionProjectViewState>): void =>
    setView((prev) => {
      const next = { ...prev, ...patch }
      saveSessionProjectViewState(folder.id, next)
      return next
    })
  const threads = useMemo(
    () =>
      sortSessionProjectThreads(
        sessionProjectThreads(data.metadata.folders, data.rows, folder.id, {
          classifications: data.classifications,
          workerParentByLeaf: data.workerParentByLeaf,
          coordinatorSessionKey: settings?.coordinator?.sessionKey,
          agentStatusByPaneKey,
          orchestrationByPaneKey,
          hostedReviewOpen,
          taskLinkByPaneKey
        })
      ),
    [
      data.metadata.folders,
      data.rows,
      data.classifications,
      data.workerParentByLeaf,
      folder.id,
      settings?.coordinator?.sessionKey,
      agentStatusByPaneKey,
      orchestrationByPaneKey,
      hostedReviewOpen,
      taskLinkByPaneKey
    ]
  )
  const archivedCount = threads.filter((thread) => thread.row.archived).length
  // Why counted before the status chips apply: a chip shows what it would select.
  const counts = useMemo(
    () =>
      countSessionProjectThreadGroups(
        filterSessionProjectThreads(threads, {
          ...sessionProjectViewFilter({ ...view, statuses: [] }),
          includeArchived: view.includeArchived
        })
      ),
    [threads, view]
  )
  const visible = useMemo(
    () =>
      searchSessionProjectThreads(
        filterSessionProjectThreads(threads, sessionProjectViewFilter(view)),
        view.search
      ),
    [threads, view]
  )
  const groups = useMemo(() => groupSessionProjectThreads(visible), [visible])
  const onReview = useProjectReviewLaunch(folder)
  const chain = sessionFolderChain(data.metadata.folders, folder.id)
  const company = chain.length > 1 ? (chain[0] ?? null) : null
  const coordinator = threads.find((thread) => thread.isCoordinator) ?? null
  // Why only with an open tab: the pane is borrowed from it; "Project chat" in the header opens one.
  const chat = coordinator && canShowSessionTerminal(coordinator.row.session) ? coordinator : null
  const drop = useProjectSessionDrop(folder.id)
  return (
    <div
      data-testid="session-project-page"
      data-session-project-page={folder.id}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <SessionProjectHeader
        folder={folder}
        settings={settings}
        company={company}
        coordinator={coordinator}
      />
      <div className="flex min-h-0 flex-1">
        <div
          {...drop.handlers}
          className={cn(
            'min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-sleek p-6',
            drop.over && 'bg-accent/30'
          )}
        >
          <div className="mx-auto max-w-5xl space-y-6">
            <SessionProjectContextChips folderId={folder.id} settings={settings} />
            <WorkDispatchComposer project={{ folderId: folder.id, name: folder.name }} />
            <SessionProjectMultiThreadLauncher
              folder={folder}
              settings={settings}
              threads={threads}
            />
            <SessionProjectFilterBar
              threads={threads}
              counts={counts}
              archivedCount={archivedCount}
              state={view}
              onChange={updateView}
            />
            <SessionProjectThreadList
              groups={groups}
              data={data}
              total={visible.length}
              filtered={isSessionProjectViewFiltered(view)}
              onReview={onReview}
            />
            <SessionProjectLibrary folderId={folder.id} threads={threads} />
            <SessionProjectRoutines folderId={folder.id} />
          </div>
        </div>
        {chat ? <SessionProjectChatPane thread={chat} activeWorktreeId={activeWorktreeId} /> : null}
      </div>
    </div>
  )
}
