import { GoalsTodosSidebarReads } from '@/components/goals-todos/GoalsTodosSidebarReads'
import { SessionSelectAllButton } from './SessionSelectAllButton'
import { FleetDispatchSummaryProvider } from './FleetDispatchSummaryProvider'
import { SessionTagFilterSummary } from './SessionTagFilterSummary'
import { JunkTitleRepairNotice } from './JunkTitleRepairNotice'
import { setSidebarGroupHidden } from './sidebar-group-and-routine-hiding'
import {
  useAgentFilteredSidebarSessions,
  useSessionTagSearchText,
  useTagFilteredFleetRuns,
  useTaggedSidebarSessions
} from './use-session-tags'
import { useRoutineOwners } from '../routines/use-routine-owners'
import { useConversationRoutineGroups } from '../routines/use-conversation-routine-groups'
import { TeamRoutinesGroup } from '../routines/TeamRoutinesGroup'
import { useSessionSnoozeMigration, useWaitingPaneTimes } from '@/lib/session-snooze'
import { useMinuteTick } from '@/lib/conversation-retention'
import { conversationViewKey } from '@/lib/conversation-view'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useAgentPaneSnapshot } from '@/components/attention/use-agent-pane-snapshot'
import { translate } from '@/i18n/i18n'
import { openSessionRow, cancelSessionRowQueue } from './session-sidebar-row-actions'
import { renameSidebarSession } from '@/lib/session-title-change'
import { buildSessionSidebarTree } from '@/lib/session-sidebar-tree'
import { focusSessionSidebarGroups } from '@/lib/session-group-focus'
import { useSessionGroupFocus } from '@/store/session-group-focus'
import { createSessionSidebarRowCache } from '@/lib/session-sidebar-row-cache'
import { useSessionSidebarTreeSnapshot } from '@/lib/session-sidebar-tree-snapshot'
import { SessionBulkActionBar } from './SessionBulkActionBar'
import { SessionSidebarFooter } from './SessionSidebarFooter'
import { archivedFleetCount } from './sidebar-cleanup-rows'
import { SessionSidebarList } from './SessionSidebarList'
import { SessionFocusView } from './SessionFocusView'
import { useSessionFocusView } from './use-session-focus-view'
import { sessionSidebarViewChoice } from '@/lib/session-sidebar-view-choice'
import { flatConversationSidebar } from '@/lib/flat-conversation-sidebar'
import { SessionFolderLoadError } from './SessionFolderLoadError'
import { rememberFirstSeen } from './session-first-seen'
import { useQueuedSessionRowKeys } from './session-queue-state'
import { useWaitingUntil } from '@/store/wait-later-store'
import { useSessionSidebarPaneMarks } from './use-session-sidebar-pane-marks'
import { startReadySessionChain, useSessionChainRows } from '@/lib/session-chain-runner'
import { useSessionSidebarGroups } from './use-session-sidebar-groups'
import { useSessionTaskRefs } from './use-session-task-refs'
import { useSidebarSessions, useSessionOwnerArchiveKeys } from './use-sidebar-sessions'
import { sessionChainRowsByRowKey, useSessionChainByRowKey } from './use-session-chain-by-row-key'
import { useSessionMultiSelection } from './use-session-multi-selection'
import { useSessionGroupSelect } from './use-session-group-select'
import {
  moveSavedFolder,
  usePickedFolderIds,
  useSelectedSidebarRows
} from './use-selected-sidebar-rows'
import { useCurrentSidebarRow } from './use-current-sidebar-row'
import { SessionSidebarToolbar } from './SessionSidebarToolbar'
import { NewConversationButton } from './NewConversationButton'
import { sidebarFolderEdits } from './session-sidebar-folder-edits'
import { fileDroppedSession } from './use-session-folder-auto-collapse'
import type { SessionFolder } from '@/lib/session-folders'
import { useSelectionFollowsRow } from './use-selection-follows-screen'
import { visibleSessionSelection } from './session-multi-selection'
import {
  useConversationFleetMonitor,
  useConversationFleetRuns
} from '@/store/conversation-fleet-store'
import { addConversationFleetGroups } from '@/lib/conversation-fleet-sidebar'
import { SessionHostScopeBar } from './SessionHostScopeBar'
import { usePublishSidebarCounts, useSessionHostScope } from './use-session-host-scope'
import { useSessionSearchGroups, useSessionSidebarSearch } from './use-session-content-search'
import {
  SessionSearchBox,
  SessionSearchHitRow,
  SessionSearchRowsScope
} from './SessionContentSearchResults'
import { useSessionSidebarLoad } from './use-session-sidebar-load'
import { useSessionLensContext } from './use-session-lens-context'
import { sessionSidebarGroupBy } from '@/lib/session-sidebar-view'

export default function SessionSidebar({ technical = false }: { technical?: boolean }) {
  const routineOwners = useRoutineOwners()
  const viewStore = useSessionSidebarView()
  const now = useMinuteTick(viewStore.view.snoozedUntil)
  const [showArchived, setShowArchived] = useState(false)
  const paneMarks = useSessionSidebarPaneMarks()
  const folders = useSessionFolders()
  const observedSessions = useSidebarSessions()
  const archivedKeys = useSessionOwnerArchiveKeys(observedSessions)
  const { allSessions: tagged, tagIds } = useTaggedSidebarSessions(observedSessions, routineOwners)
  useSessionSnoozeMigration(tagged)
  const allSessions = useAgentFilteredSidebarSessions(tagged, archivedKeys)
  const fleetRuns = useConversationFleetRuns()
  useConversationFleetMonitor()
  const waitingUntil = useWaitingUntil()
  const waitingUntilByPaneKey = useWaitingPaneTimes(waitingUntil)
  const snapshot = useAgentPaneSnapshot()
  // Why: every agent ping republishes the whole snapshot, but the tree reads only pane cards and
  // attention — holding that projection steady lets an unrelated ping skip the rebuild entirely.
  const treeSnapshot = useSessionSidebarTreeSnapshot(snapshot)
  const { sessions, ...hosts } = useSessionHostScope(allSessions, fleetRuns, treeSnapshot)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const queuedRowKeys = useQueuedSessionRowKeys()
  const chainRows = useSessionChainRows()
  const chainByRowKey = useSessionChainByRowKey(chainRows)
  const chainsByRowKey = useMemo(
    () => sessionChainRowsByRowKey(chainRows, chainByRowKey),
    [chainRows, chainByRowKey]
  )
  const [query, setQuery] = useState('')
  const batchOrigins = useSessionSidebarLoad(folders, viewStore)
  const lensContext = useSessionLensContext({
    view: viewStore.view,
    hostOptions: hosts.bar.hostOptions,
    tagIds
  })

  const groupByTask = sessionSidebarGroupBy(viewStore.view) === 'task'
  const taskFor = useSessionTaskRefs(groupByTask, sessions)
  // Why: under the task lens a conversation answers to its task's name as well as its own.
  const tagSearchText = useSessionTagSearchText(tagIds, groupByTask ? taskFor : undefined)
  const { contentSearch, searchText } = useSessionSidebarSearch(
    query,
    allSessions,
    tagSearchText,
    folders.metadata
  )

  // Why: grouping is global, so a moved row still rebuilds the tree — but with the cache only
  // the rows whose own inputs changed are classified again, not all five hundred.
  const rowCache = useRef(createSessionSidebarRowCache()).current
  const tree = useMemo(
    () =>
      buildSessionSidebarTree({
        routineOwners,
        rowCache,
        now,
        showArchived,
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
        snapshot: treeSnapshot,
        query,
        searchText,
        showHidden: viewStore.showHidden,
        batchOrigins,
        lensContext
      }),
    [
      batchOrigins,
      lensContext,
      routineOwners,
      rowCache,
      now,
      showArchived,
      chainsByRowKey,
      chainByRowKey,
      paneMarks,
      folders.metadata,
      query,
      searchText,
      sessions,
      treeSnapshot,
      viewStore.showHidden,
      viewStore.view,
      archivedKeys,
      waitingUntilByPaneKey,
      waitingUntil
    ]
  )
  const filteredFleetRuns = useTagFilteredFleetRuns(hosts.fleetRuns, observedSessions, tagIds)
  const sharedGroups = useSessionSidebarGroups({
    groups: tree.groups,
    view: viewStore.view,
    query,
    groupByTask,
    taskFor
  })
  const fleetGroups = useMemo(
    () =>
      addConversationFleetGroups({
        now,
        showArchived,
        waitingUntil,
        groups: sharedGroups,
        sessions: allSessions,
        runs: filteredFleetRuns,
        view: viewStore.view,
        query
      }),
    [
      sharedGroups,
      allSessions,
      filteredFleetRuns,
      viewStore.view,
      query,
      now,
      showArchived,
      waitingUntil
    ]
  )
  const listInput = { technical, folders, viewStore, archivedKeys, query, showArchived }
  const withRoutines = useConversationRoutineGroups(fleetGroups, listInput)
  const groups = withRoutines.groups
  const { currentKey, currentKeys, onScreen, renderRoutineRow } = useCurrentSidebarRow(
    withRoutines,
    sessions,
    listInput
  )
  const focusedScreen = onScreen.find((target) => target.focused) ?? null
  // New activity expands groups previously folded by the idle timer.
  const trimmed = useSessionGroupFocus((state) => state.trimmed)
  useEffect(() => useSessionGroupFocus.getState().reset(), [currentKey])
  const listGroups = useMemo(
    () =>
      focusSessionSidebarGroups(
        groups,
        currentKey ? [currentKey, ...currentKeys.filter((key) => key !== currentKey)] : currentKeys,
        trimmed
      ),
    [groups, currentKey, currentKeys, trimmed]
  )
  const focus = useSessionFocusView({ groups, listGroups, technical, query, now, tree })
  const searchGroups = useSessionSearchGroups(
    groups,
    folders.metadata,
    contentSearch,
    tagSearchText
  )
  const flat = sessionSidebarViewChoice(viewStore.view) === 'flat'
  const shownGroups = useMemo(
    () =>
      flat
        ? flatConversationSidebar(searchGroups ?? groups, viewStore.view)
        : (searchGroups ?? focus.listGroups),
    [flat, searchGroups, groups, viewStore.view, focus.listGroups]
  )
  const visible = useMemo(() => visibleSessionSelection(shownGroups), [shownGroups])
  useSelectionFollowsRow(currentKey, currentKey !== null && visible.order.includes(currentKey))
  const listRef = useRef<HTMLDivElement>(null)
  const revealRef = useRef<((key: string) => void) | null>(null)
  const selection = useSessionMultiSelection(visible.order, listRef, revealRef)
  const selectedRows = useSelectedSidebarRows(visible, selection.selectedKeys)
  const selectGroup = useSessionGroupSelect(
    groups,
    folders.metadata.folders,
    viewStore,
    selection.selectKeys
  )
  const pickedFolderIds = usePickedFolderIds(folders.metadata.folders)
  const bulkSessions = selection.bulk && selectedRows.count > 0
  const allVisibleSelected =
    visible.order.length > 0 && visible.order.every((key) => selection.selectedKeys.has(key))
  const archivedCount =
    tree.archivedCount +
    withRoutines.archivedCount +
    archivedFleetCount(hosts.fleetRuns, allSessions, archivedKeys, viewStore.view.deleted)
  const hiddenCount = tree.hiddenCount + withRoutines.hiddenCount
  usePublishSidebarCounts(hosts, { archivedCount, hiddenCount, showArchived, archivedKeys })

  return (
    <FleetDispatchSummaryProvider runs={fleetRuns}>
      <section
        data-session-list-flat={flat || undefined}
        aria-label={translate(
          'auto.components.SessionSidebar.technicalSessionsHeading',
          'Sessions'
        )}
        className="flex min-h-0 flex-1 flex-col text-worktree-sidebar-foreground"
      >
        <GoalsTodosSidebarReads sessions={observedSessions} />
        <div className="space-y-2 px-2 pb-2 pt-1">
          {technical ? (
            <div className="flex min-w-0 items-center gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {translate('auto.components.SessionSidebar.technicalSessionsHeading', 'Sessions')}
              </span>
            </div>
          ) : null}
          <SessionHostScopeBar {...hosts.bar} />
          <SessionSearchBox query={query} onQuery={setQuery} search={contentSearch} />
          <SessionSidebarToolbar
            {...{ observedSessions, groups, currentKeys, listRef, folders, viewStore }}
          />
          <SessionTagFilterSummary />
          {technical ? null : <JunkTitleRepairNotice sessions={observedSessions} />}
          <SessionSelectAllButton
            count={visible.order.length}
            allSelected={allVisibleSelected}
            onToggle={selection.toggleAll}
          />
          <SessionFolderLoadError folders={folders} />
        </div>
        <SessionFocusView focus={focus} listRef={listRef} onKeyDown={selection.handleKeyDown}>
          {technical || focus.mode === 'focus' ? null : <TeamRoutinesGroup query={query} quiet />}
          <SessionSearchRowsScope
            {...{ query, hiddenCount }}
            empty={!shownGroups.length}
            search={contentSearch}
          >
            <SessionSidebarList
              flat={flat}
              groups={shownGroups}
              listRef={listRef}
              revealRef={revealRef}
              renderRoutineRow={searchGroups ? undefined : renderRoutineRow}
              onSelectFleetRow={(key, event) => selection.select(event, key)}
              renderSearchHit={(hit) => (
                <SessionSearchHitRow {...{ hit, now }} search={contentSearch} />
              )}
              groupProps={{
                routineCommands: withRoutines.commands,
                technical,
                folders: folders.metadata.folders,
                activeTabId: focusedScreen?.tabId ?? null,
                activeLeafId: focusedScreen?.leafId ?? null,
                activeWorktreeId: focusedScreen?.worktreeId ?? activeWorktreeId,
                onScreen,
                queuedRowKeys,
                chainsByRowKey,
                now,
                selectedKeys: selection.selectedKeys,
                focusKey: selection.focusKey ?? visible.order[0] ?? null,
                onSelect: (session, event) => selection.select(event, conversationViewKey(session)),
                onStartChain: (session) => {
                  const chain = chainsByRowKey.get(session.rowKey)
                  if (chain) {
                    startReadySessionChain(chain.chainId)
                  }
                },
                onToggle: (key) => {
                  if (searchGroups || focus.handleToggle(key)) {
                    return
                  }
                  // Why: opening (or folding) a group by hand always lists every row in it again.
                  useSessionGroupFocus.getState().showAll(key)
                  viewStore.toggleCollapsed(key)
                },
                onShowAll: useSessionGroupFocus.getState().showAll,
                onSelectGroup: selectGroup,
                onHide: setSidebarGroupHidden,
                onMoveGroup: (key, target, position) =>
                  viewStore.moveGroup({ key, target, position, visibleKeys: tree.reorderableKeys }),
                onMoveFolder: moveSavedFolder,
                onCreateSavedFolder: sidebarFolderEdits.createSaved,
                onRenameFolder: sidebarFolderEdits.rename,
                onDeleteFolder: (folder) => {
                  if (sidebarFolderEdits.remove(folder)) {
                    toast.success(
                      translate(
                        'auto.components.SessionSidebar.folderDeleted',
                        'Folder deleted. Sessions were kept.'
                      )
                    )
                  }
                },
                onOpen: openSessionRow,
                onRename: renameSidebarSession,
                onMoveSessionKey: fileDroppedSession,
                folderLauncher: renderFolderLauncher,
                onCancelQueue: cancelSessionRowQueue
              }}
            />
          </SessionSearchRowsScope>
        </SessionFocusView>
        {/* Why folders alone too: picked folders delete from the same bar. */}
        {bulkSessions || pickedFolderIds.length > 0 ? (
          <SessionBulkActionBar
            sessions={bulkSessions ? selectedRows.sessions : []}
            fleetRows={bulkSessions ? selectedRows.fleet : undefined}
            routines={bulkSessions ? selectedRows.routines : undefined}
            routineCommands={withRoutines.commands}
            folders={folders.metadata.folders}
            folderIds={pickedFolderIds}
            queuedRowKeys={queuedRowKeys}
            onCreateFolder={sidebarFolderEdits.create}
            onClear={selection.clear}
            onCompleted={selection.remove}
          />
        ) : null}
        <SessionSidebarFooter
          hiddenCount={hiddenCount}
          showHidden={viewStore.showHidden}
          onShowHidden={viewStore.setShowHidden}
          archivedCount={archivedCount}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
        />
      </section>
    </FleetDispatchSummaryProvider>
  )
}

function renderFolderLauncher(folder: SessionFolder, label: string): React.ReactNode {
  return <NewConversationButton folder={{ id: folder.id, name: label }} />
}
