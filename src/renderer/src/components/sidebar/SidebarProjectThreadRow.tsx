import React from 'react'
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  FolderOutput,
  Layers,
  Settings2,
  Sparkles
} from 'lucide-react'
import { toast } from 'sonner'
import { openProjectSettings } from '@/components/projects/project-settings-dialog-store'
import { NewConversationButton } from '@/components/sidebar/session-folders/NewConversationButton'
import { sessionSidebarDragBatch } from '@/components/sidebar/session-folders/session-sidebar-batch'
import { fileDroppedSession } from '@/components/sidebar/session-folders/use-session-folder-auto-collapse'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import { archiveSessionsByPerson } from '@/lib/session-organization-person-changes'
import {
  beginSessionSidebarDrag,
  clearSessionSidebarDrag,
  writeSessionSidebarDrag
} from '@/lib/session-sidebar-drag'
import { sessionWorkspaceGroupKey } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { cn } from '@/lib/utils'
import type { ProjectFolderNode } from '../../../../shared/session-project-folder'

export function SidebarProjectThreadRow({
  session,
  folderName,
  coordinatorKey,
  archivedSet,
  agentStatusByPaneKey
}: {
  session: SidebarSession
  folderName: string
  coordinatorKey: string | null
  archivedSet: ReadonlySet<string>
  agentStatusByPaneKey: Readonly<Record<string, { state?: string } | undefined>> | undefined
}): React.JSX.Element {
  const viewKey = conversationViewKey(session)
  const isCoord = coordinatorKey !== null && viewKey === coordinatorKey
  const isArchived = Boolean(viewKey && archivedSet.has(viewKey))
  const title = session.customTitle ?? session.label
  const paneState = session.paneKey ? agentStatusByPaneKey?.[session.paneKey]?.state : undefined
  const statusColor =
    paneState === 'working'
      ? 'bg-emerald-500'
      : paneState === 'blocked' || paneState === 'waiting'
        ? 'bg-amber-500'
        : 'bg-worktree-sidebar-foreground/30'

  const archiveTitle = isArchived
    ? translate('conversations.unarchiveItem', 'Unarchive {{name}}', { name: title })
    : translate('conversations.archiveItem', 'Archive {{name}}', { name: title })

  return (
    <li
      draggable
      onDragStart={(event) => {
        if (!viewKey) {
          return
        }
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'move'
        writeSessionSidebarDrag(event.dataTransfer, {
          kind: 'row',
          sessionKey: viewKey
        })
        const batch = sessionSidebarDragBatch({ sessionKey: viewKey })
        beginSessionSidebarDrag({
          kind: 'row',
          sessionKey: viewKey,
          workspaceGroupKey: sessionWorkspaceGroupKey(session),
          ...(batch ? { batch } : {})
        })
      }}
      onDragEnd={() => clearSessionSidebarDrag()}
      className="group/thread flex cursor-grab items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-worktree-sidebar-foreground/80 transition-colors hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-foreground active:cursor-grabbing"
      data-sidebar-project-thread={viewKey}
    >
      <button
        type="button"
        onClick={() => openSidebarSession(session)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', statusColor)} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {isCoord ? (
        <span className="shrink-0 rounded bg-primary/15 px-1 py-px text-[9px] font-medium text-primary group-hover/thread:hidden">
          Coord
        </span>
      ) : (
        <span className="shrink-0 rounded border border-worktree-sidebar-foreground/15 px-1 py-px text-[9px] uppercase opacity-65 group-hover/thread:hidden">
          {session.agent}
        </span>
      )}
      <div
        className="hidden shrink-0 items-center gap-0.5 group-hover/thread:flex"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => {
            if (!viewKey) {
              return
            }
            archiveSessionsByPerson([viewKey], !isArchived)
            toast.success(
              isArchived
                ? translate('conversations.unarchivedToast', 'Unarchived {{name}}', { name: title })
                : translate('conversations.archivedToast', 'Archived {{name}}', { name: title })
            )
          }}
          title={archiveTitle}
          aria-label={archiveTitle}
          data-project-thread-archive={viewKey}
          className="rounded p-0.5 text-muted-foreground hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground"
        >
          {isArchived ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (!viewKey) {
              return
            }
            fileDroppedSession(viewKey, null)
            toast.success(
              translate(
                'projects.sidebar.removedFromProject',
                'Removed {{name}} from {{project}}',
                { name: title, project: folderName }
              )
            )
          }}
          title={translate('projects.sidebar.removeFromProject', 'Remove from project')}
          aria-label={translate('projects.sidebar.removeFromProject', 'Remove from project')}
          data-project-thread-unfile={viewKey}
          className="rounded p-0.5 text-muted-foreground hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground"
        >
          <FolderOutput className="size-3" />
        </button>
      </div>
    </li>
  )
}

export function SidebarProjectItem({
  folder,
  isSelected,
  isExpanded,
  isDragOver,
  projectSessions,
  showAll,
  coordinatorKey,
  fleetCount,
  archivedSet,
  agentStatusByPaneKey,
  onToggleExpand,
  onOpenProject,
  onToggleShowAll,
  onDragOver,
  onDragLeave,
  onDrop
}: {
  folder: ProjectFolderNode
  isSelected: boolean
  isExpanded: boolean
  isDragOver: boolean
  projectSessions: readonly SidebarSession[]
  showAll: boolean
  coordinatorKey: string | null
  fleetCount: number
  archivedSet: ReadonlySet<string>
  agentStatusByPaneKey: Readonly<Record<string, { state?: string } | undefined>> | undefined
  onToggleExpand: (e: React.MouseEvent) => void
  onOpenProject: () => void
  onToggleShowAll: () => void
  onDragOver: (e: React.DragEvent<HTMLElement>) => void
  onDragLeave: (e: React.DragEvent<HTMLElement>) => void
  onDrop: (e: React.DragEvent<HTMLElement>) => void
}): React.JSX.Element {
  const visibleThreads = showAll ? projectSessions : projectSessions.slice(0, 10)
  return (
    <li
      data-sidebar-project-item={folder.id}
      data-drag-over={isDragOver || undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={cn(
        'rounded-md transition-colors',
        isDragOver && 'bg-primary/10 ring-1 ring-primary'
      )}
    >
      <div
        className={cn(
          'group flex h-7 items-center gap-1 rounded-md px-1 text-[12px] transition-colors',
          isSelected
            ? 'bg-worktree-sidebar-accent font-medium text-worktree-sidebar-accent-foreground'
            : 'text-worktree-sidebar-foreground/85 hover:bg-worktree-sidebar-accent'
        )}
      >
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={translate('projects.sidebar.expandThreads', 'Show project threads')}
          className="rounded p-0.5 text-muted-foreground hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground"
        >
          {isExpanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={onOpenProject}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <FolderKanban className="size-3.5 shrink-0 opacity-75" />
          <span className="truncate font-medium">{folder.name}</span>
        </button>
        {isDragOver ? (
          <span className="rounded bg-primary/20 px-1.5 py-px text-[9px] font-semibold text-primary">
            {translate('projects.sidebar.dropHere', 'Drop')}
          </span>
        ) : null}
        {fleetCount > 1 && !isDragOver ? (
          <span
            title={translate(
              'projects.sidebar.multiModelFleet',
              'Multi-model parallel thread fleet ({{count}} models)',
              { count: fleetCount }
            )}
            className="hidden items-center gap-0.5 rounded bg-primary/15 px-1 py-px text-[9px] font-medium text-primary group-hover:inline-flex"
          >
            <Layers className="size-2.5" />
            {fleetCount}
          </span>
        ) : null}
        <span className="rounded px-1 text-[10px] tabular-nums text-muted-foreground">
          {projectSessions.length}
        </span>
        <div
          className="hidden items-center gap-0.5 group-hover:flex"
          onClick={(e) => e.stopPropagation()}
        >
          <NewConversationButton folder={{ id: folder.id, name: folder.name }} />
          <button
            type="button"
            onClick={() => openProjectSettings(folder.id)}
            title={translate('projects.page.settings', 'Project settings')}
            aria-label={translate('projects.page.settings', 'Project settings')}
            className="rounded p-0.5 text-muted-foreground hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground"
          >
            <Settings2 className="size-3.5" />
          </button>
        </div>
      </div>

      {isExpanded ? (
        <ul
          className="ml-3.5 mt-0.5 space-y-0.5 border-l border-worktree-sidebar-border pl-1.5"
          data-sidebar-project-threads={folder.id}
        >
          {visibleThreads.map((session) => (
            <SidebarProjectThreadRow
              key={session.rowKey}
              session={session}
              folderName={folder.name}
              coordinatorKey={coordinatorKey}
              archivedSet={archivedSet}
              agentStatusByPaneKey={agentStatusByPaneKey}
            />
          ))}
          {projectSessions.length > 10 ? (
            <li>
              <button
                type="button"
                onClick={onToggleShowAll}
                className="w-full rounded px-1.5 py-0.5 text-left text-[10px] font-medium text-primary hover:underline"
              >
                {showAll
                  ? translate('projects.sidebar.showFewerThreads', 'Show fewer threads')
                  : translate('projects.sidebar.viewAllThreads', 'Show all {{count}} threads →', {
                      count: projectSessions.length
                    })}
              </button>
            </li>
          ) : null}
          <li>
            <button
              type="button"
              onClick={onOpenProject}
              className="flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-left text-[10px] text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-foreground"
            >
              <Sparkles className="size-2.5 text-primary" />
              <span>
                {translate(
                  'projects.sidebar.openMultiThreadLauncher',
                  'Launch multi-model threads & memory…'
                )}
              </span>
            </button>
          </li>
        </ul>
      ) : null}
    </li>
  )
}
