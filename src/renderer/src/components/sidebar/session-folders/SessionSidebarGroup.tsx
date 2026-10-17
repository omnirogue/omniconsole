import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { conversationViewKey } from '@/lib/conversation-view'
import { useState } from 'react'
import { ChevronDown, GripVertical } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { sessionFolderColorVar, sessionGroupColor } from '@/lib/session-folder-colors'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionFolderSection } from '@/lib/session-folder-tree'
import { clearSessionSidebarDrag } from '@/lib/session-sidebar-drag'
import {
  sessionGroupListedRows,
  type SessionSidebarGroup as SessionSidebarGroupModel,
  type SessionSidebarTreeRow
} from '@/lib/session-sidebar-tree'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { isSidebarSessionOnScreen } from '@/lib/sidebar-session-on-screen'
import {
  sidebarSessionScreenPresence,
  type OnScreenSessionTarget
} from '@/lib/sidebar-sessions-on-screen'
import { cn } from '@/lib/utils'
import { SessionGroupShowAll } from './SessionGroupShowAll'
import {
  FolderNestingGuides,
  folderNestingLevels,
  savedFolderIndentStyle
} from './SavedFolderControls'
import { Checkbox } from '@/components/ui/checkbox'
import { sessionFolderPath } from '@/lib/session-folder-tree'
import { useSessionSelection } from '@/store/session-selection'
import { SessionSidebarGroupIcon } from './SessionSidebarGroupIcon'
import { SessionSidebarGroupHeaderActions } from './SessionSidebarGroupHeaderActions'
import { SessionGroupOwnerState } from './SessionGroupOwnerState'
import type { SessionGroupSelectMode } from './use-session-group-select'
import { SessionSidebarTreeRowItem } from './SessionSidebarTreeRowItem'
import { SessionRowHostBucketContext } from './use-session-row-host-label'
import { computerLensBucketId } from '@/lib/session-sidebar-lens'
import { SessionFolderStatusStrip } from './SessionFolderTally'
import { SessionGroupHeaderCounts } from './SessionGroupHeaderCounts'
import { sessionFolderHeadingTitle } from './session-folder-heading-title'
import type { SessionSidebarGroupWindow } from './session-sidebar-virtual-rows'
import { useSessionGroupDrop } from './use-session-group-drop'
import { useSessionGroupRowHandlers } from './use-session-group-row-handlers'
import type { RoutineCommands } from '../routines/routine-row-commands'
import { sessionGroupBodyClass } from './session-folder-layout-classes'

export type SessionSidebarGroupProps = {
  routineCommands?: Pick<RoutineCommands, 'setEnabled'>
  technical?: boolean
  hideHeader?: boolean
  group: SessionSidebarGroupModel
  /** A control placed before the group's heading, outside its collapse toggle. */
  headerStart?: React.ReactNode
  extraRows?: React.ReactNode
  /** One extra row by index; a windowed list renders only the extras in its window. */
  renderExtraRow?: (index: number) => React.ReactNode
  extraRowCount?: number
  folders: readonly SessionFolder[]
  /** The tab on the main screen in row identity (see selectOnScreenSessionTabId). */
  activeTabId: string | null
  /** The focused pane's leaf when that tab is split; only its row is current then. */
  activeLeafId?: string | null
  activeWorktreeId: string | null
  /** Every conversation on the main screen; its rows wear the on-screen mark. */
  onScreen?: readonly OnScreenSessionTarget[]
  queuedRowKeys: ReadonlySet<string>
  chainsByRowKey?: ReadonlyMap<string, SessionChainRowInfo>
  /** Multi-selection by view key; absent when the tree is not selectable. */
  selectedKeys?: ReadonlySet<string>
  /** The row carrying the roving tabIndex; null when no row does yet. */
  focusKey?: string | null
  /** Clock for snooze captions. */
  now?: number
  /** The windowed slice of a virtualized list; absent renders the whole group. */
  window?: SessionSidebarGroupWindow
  /** Measures a windowed element; set together with `window`. */
  measure?: (element: HTMLElement | null) => void
  onSelect?: (session: SidebarSession, event: React.MouseEvent<HTMLElement>) => boolean
  onStartChain?: (session: SidebarSession) => void
  onToggle: (key: string) => void
  /** List every row of a group folded down to the conversation in use. */
  onShowAll?: (key: string) => void
  onHide: (key: string, hidden: boolean) => void
  onMoveGroup: (key: string, target: string, position: 'before' | 'after') => void
  onCreateSavedFolder?: (name: string, parentId?: string) => boolean
  onRenameFolder: (folder: SessionFolder, name: string) => boolean
  onDeleteFolder: (folder: SessionFolder) => void
  /** Select every row in the group (and folders nested under it); absent where nothing selects. */
  onSelectGroup?: (group: SessionSidebarGroupModel, mode: SessionGroupSelectMode) => void
  onOpen: (session: SidebarSession) => void
  onRename?: (session: SidebarSession, title: string | null) => void
  onMoveSessionKey: (sessionKey: string, folderId: string | null) => void
  /** Put a folder, with its subfolders and sessions, inside another or at the top of a section. */
  onMoveFolder?: (folderId: string, parentId: string | null, section: SessionFolderSection) => void
  onCancelQueue: (session: SidebarSession) => void
  /** A folder's own "+"; absent where the tree cannot start conversations. */
  folderLauncher?: (folder: SessionFolder, label: string) => React.ReactNode
}

export function SessionSidebarGroup(props: SessionSidebarGroupProps): React.JSX.Element {
  const { group, folders, onToggle, onMoveGroup, onMoveSessionKey, window: slice } = props
  const [renameOpen, setRenameOpen] = useState(false)
  const folderId = group.folder?.id ?? null
  // Why: only folders that can move can be picked; a pick is what a multi-item drag carries.
  const canPickFolder = Boolean(folderId && props.onMoveFolder)
  const folderPicked = useSessionSelection((state) =>
    folderId ? state.folderIds.has(folderId) : false
  )
  const nestingLevels = folderNestingLevels(group.folder, group.depth)
  const color = useSessionSidebarView((state) =>
    sessionGroupColor(state.view, group.key, group.folder, folders)
  )
  // Why: saved and archived rows are done by definition, so they wear the folder color instead.
  const putAway =
    group.kind === 'saved' || group.kind === 'archived' || group.folder?.section === 'saved'
  const listedRows = sessionGroupListedRows(group)
  // Why: a folder says whether anything in it is moving, open or folded, without scanning its rows.
  const activeCount = group.rows.filter(
    (row) => row.pursuitState === 'running' || row.pursuitState === 'working'
  ).length
  // Why only with members: an empty folder keeps its plain heading.
  const tally = group.folderTally?.total ? group.folderTally : null
  const hostBucket = computerLensBucketId(group)
  const handlers = useSessionGroupRowHandlers(props)
  const drop = useSessionGroupDrop({
    launchFolderId: props.folderLauncher ? (folderId ?? undefined) : undefined,
    group,
    folders,
    onMoveGroup,
    onMoveSessionKey,
    onMoveFolder: props.onMoveFolder
  })
  const { dropTarget } = drop
  const extraRowCount = props.extraRowCount ?? 0
  const total = group.rows.length + extraRowCount
  // Why: while a group is folded down to the conversation in use, the rest wait behind this.
  const showAll =
    group.focusRows && !group.collapsed && total > group.focusRows.length ? (
      <SessionGroupShowAll count={total} onShowAll={() => props.onShowAll?.(group.key)} />
    ) : null
  // Why: a windowed item carries its own gap as padding, so measured heights add up exactly.
  const measured = (index: number | null, key: string, node: React.ReactNode): React.ReactNode =>
    slice ? (
      index === null ? null : (
        <div
          key={key}
          data-index={index}
          ref={props.measure}
          className={cn('flow-root', index === slice.end && 'pb-1')}
        >
          {node}
        </div>
      )
    ) : (
      node
    )
  const renderRow = (row: SessionSidebarTreeRow, index: number | null): React.ReactNode => {
    const key = conversationViewKey(row.session)
    return measured(
      index,
      row.session.rowKey,
      <div key={row.session.rowKey} className={cn(slice && 'pb-px')}>
        <SessionSidebarTreeRowItem
          row={row}
          handlers={handlers}
          technical={props.technical}
          current={isSidebarSessionOnScreen(row.session, {
            worktreeId: props.activeWorktreeId,
            tabId: props.activeTabId,
            leafId: props.activeLeafId
          })}
          onScreen={
            props.onScreen
              ? sidebarSessionScreenPresence(row.session, props.onScreen) !== null
              : false
          }
          selected={props.selectedKeys?.has(key) ?? false}
          focused={props.focusKey === undefined ? undefined : props.focusKey === key}
          queued={props.queuedRowKeys.has(row.session.rowKey)}
          chain={props.chainsByRowKey?.get(row.session.rowKey) ?? null}
          now={row.waitingUntil ? props.now : undefined}
          color={color}
          putAway={putAway}
        />
        {/* Why here: a windowed list measures rows, so the control rides in the group's last one. */}
        {slice && index === slice.end ? showAll : null}
      </div>
    )
  }

  const expandLabel = group.collapsed
    ? translate('auto.components.SessionSidebar.expandGroup', 'Expand {{group}}', {
        group: group.label
      })
    : translate('auto.components.SessionSidebar.collapseGroup', 'Collapse {{group}}', {
        group: group.label
      })
  const showBody = slice
    ? slice.rows.length > 0 || slice.extra.length > 0
    : !group.collapsed || listedRows.length > 0
  const colorStyle = color
    ? ({ '--session-group-color': sessionFolderColorVar(color) } as React.CSSProperties)
    : undefined

  const header = (
    <div
      className={cn(
        'group/session-header relative flex h-7 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-worktree-sidebar-accent',
        drop.launchOver && 'ring-1 ring-ring',
        color && 'bg-[color-mix(in_srgb,var(--session-group-color)_12%,transparent)]',
        (dropTarget?.kind === 'row' || dropTarget?.kind === 'folder') &&
          'bg-worktree-sidebar-accent ring-1 ring-worktree-sidebar-ring/50',
        dropTarget?.kind === 'group' &&
          dropTarget.position === 'before' &&
          'shadow-[inset_0_2px_0_0_var(--ring)]',
        dropTarget?.kind === 'group' &&
          dropTarget.position === 'after' &&
          'shadow-[inset_0_-2px_0_0_var(--ring)]',
        drop.draggable && 'cursor-grab active:cursor-grabbing',
        folderPicked && 'bg-worktree-sidebar-accent/60 ring-1 ring-inset ring-worktree-sidebar-ring'
      )}
      style={colorStyle}
      data-folder-selected={folderPicked || undefined}
      data-session-group-color={color ?? undefined}
      draggable={drop.draggable || undefined}
      data-session-group-drop={
        dropTarget
          ? dropTarget.kind === 'group'
            ? dropTarget.position
            : dropTarget.kind === 'folder'
              ? 'into'
              : 'row'
          : undefined
      }
      {...drop.launchIntentHandlers}
      onDragStart={drop.handleHeaderDragStart}
      onDragEnd={clearSessionSidebarDrag}
      onDragOver={drop.handleDragOver}
      onDragLeave={drop.handleDragLeave}
      onDrop={drop.handleDrop}
    >
      {tally ? <SessionFolderStatusStrip tally={tally} /> : null}
      {props.headerStart}
      {drop.draggable ? (
        <span
          draggable
          data-session-group-drag-handle=""
          aria-label={translate('sidebar.dragRow', 'Drag {{label}}', { label: group.label })}
          title={translate('sidebar.dragRow', 'Drag {{label}}', { label: group.label })}
          className="shrink-0 cursor-grab px-0.5 text-muted-foreground"
        >
          <GripVertical className="size-3" aria-hidden />
        </span>
      ) : null}
      {canPickFolder ? (
        <Checkbox
          className="shrink-0"
          checked={folderPicked}
          aria-label={translate('conversations.selectFolder', 'Select folder {{folder}}', {
            folder: group.label
          })}
          onCheckedChange={() => useSessionSelection.getState().toggleFolder(folderId!)}
        />
      ) : null}
      <button
        type="button"
        aria-expanded={!group.collapsed}
        aria-label={expandLabel}
        onClick={(event) => {
          // Why: ⌘/Ctrl-click picks a folder the way it picks a session, instead of folding it.
          if (canPickFolder && (event.metaKey || event.ctrlKey)) {
            useSessionSelection.getState().toggleFolder(folderId!)
            return
          }
          onToggle(group.key)
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring"
      >
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            group.collapsed && '-rotate-90'
          )}
        />
        <SessionSidebarGroupIcon kind={group.kind} color={color} open={!group.collapsed} />
        <span
          title={
            group.folder
              ? sessionFolderHeadingTitle(
                  sessionFolderPath(folders, group.folder),
                  group.batchOrigin
                )
              : undefined
          }
          className={cn(
            'min-w-0 flex-1 truncate text-[12px] font-semibold',
            nestingLevels > 0 && group.folder?.parentId && 'font-medium',
            group.kind === 'attention' && 'text-agent-question-text'
          )}
        >
          {group.label}
        </span>
        <SessionGroupHeaderCounts
          group={group}
          folders={folders}
          tally={tally}
          activeCount={activeCount}
          listedCount={group.rows.length + extraRowCount + (group.childRowCount ?? 0)}
        />
      </button>
      <SessionSidebarGroupHeaderActions
        {...props}
        renameOpen={renameOpen}
        onRenameOpenChange={setRenameOpen}
      />
    </div>
  )

  // Why measured with the heading: a windowed list sizes the owner's state line with it (G2).
  const headerBlock = (
    <>
      {header}
      {hostBucket ? <SessionGroupOwnerState hostId={hostBucket} /> : null}
    </>
  )

  return (
    <div
      role="group"
      aria-label={group.label}
      data-session-group={group.key}
      data-session-group-kind={group.kind}
      data-session-group-hidden={group.hidden ? '' : undefined}
      data-session-group-collapsed={group.collapsed ? '' : undefined}
      data-session-group-depth={group.folder ? (group.depth ?? 0) : undefined}
      style={savedFolderIndentStyle(group.folder, group.depth)}
      className={cn('relative', !slice && 'mb-1', group.hidden && 'opacity-60')}
    >
      <FolderNestingGuides levels={nestingLevels} />
      {props.hideHeader
        ? null
        : slice
          ? measured(slice.header, 'header', headerBlock)
          : headerBlock}
      {showBody ? (
        // Why: the body is a drop target too, beside the header. An empty folder shows no
        // filler: its count and subfolder mark already say what it holds.
        <div
          style={colorStyle}
          className={cn(
            !props.hideHeader && sessionGroupBodyClass(group.kind),
            // Why: the folder's color runs down its rail, so a row reads as belonging to it.
            color && 'border-l-2 border-[var(--session-group-color)]',
            !slice && 'space-y-px',
            (dropTarget?.kind === 'row' || dropTarget?.kind === 'folder') &&
              'rounded-md bg-worktree-sidebar-accent/60'
          )}
          data-session-group-zone="body"
          data-session-group-body-drop={
            dropTarget?.kind === 'row' ? 'row' : dropTarget?.kind === 'folder' ? 'into' : undefined
          }
          onDragOver={props.hideHeader ? undefined : drop.handleBodyDragOver}
          onDragLeave={props.hideHeader ? undefined : drop.handleDragLeave}
          onDrop={props.hideHeader ? undefined : drop.handleBodyDrop}
        >
          {/* Why: a Computer bucket's heading names its computer, so its rows need not repeat it. */}
          <SessionRowHostBucketContext.Provider value={hostBucket}>
            {slice
              ? slice.rows.map(({ row, index }) => renderRow(row, index))
              : listedRows.map((row) => renderRow(row, null))}
            {slice
              ? slice.extra.map(({ index, extraIndex, extraKey }) =>
                  // Why: the receipt's own key, so a reorder does not hand its open details
                  // dialog or pause spinner to whichever workflow lands in that slot.
                  measured(index, `extra:${extraKey}`, props.renderExtraRow?.(extraIndex))
                )
              : group.collapsed || group.focusRows
                ? null
                : props.extraRows}
            {slice ? null : showAll}
          </SessionRowHostBucketContext.Provider>
        </div>
      ) : null}
    </div>
  )
}
