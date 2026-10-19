import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FolderKanban, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { openProjectCreate } from '@/components/projects/project-settings-dialog-store'
import { moveSessionSidebarBatch } from '@/components/sidebar/session-folders/session-sidebar-batch'
import { fileDroppedSession } from '@/components/sidebar/session-folders/use-session-folder-auto-collapse'
import { useSidebarSessions } from '@/components/sidebar/session-folders/use-sidebar-sessions'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import { sessionFolderSubtreeIds } from '@/lib/session-folder-tree'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import {
  clearSessionSidebarDrag,
  getSessionSidebarDrag,
  readSessionSidebarDrag,
  readSessionSidebarDragKind
} from '@/lib/session-sidebar-drag'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { isProjectFolder, type ProjectFolderNode } from '../../../../shared/session-project-folder'
import { SidebarProjectItem } from './SidebarProjectThreadRow'

const AUTOMATED_FOLDER_NAME_RE = /^(Canary\b|Batch \d{2}-\d{2}\b|Verify fix$)/i

export function isSidebarProjectFolder(
  folder: ProjectFolderNode,
  folders: readonly ProjectFolderNode[],
  projects?: Readonly<Record<string, unknown>>
): boolean {
  if (projects?.[folder.id]) {
    return true
  }
  return isProjectFolder(folders, folder.id) && !AUTOMATED_FOLDER_NAME_RE.test(folder.name.trim())
}

export function filterNonProjectFlatGroups<
  T extends { kind: string; folder?: { id: string } | null }
>(groups: readonly T[], metadata: SessionFolderMetadata, query: string): readonly T[] {
  if (query.trim()) {
    return groups
  }
  const projectSubtreeIds = new Set<string>()
  for (const folder of metadata.folders) {
    if (isSidebarProjectFolder(folder, metadata.folders, metadata.projects)) {
      for (const id of sessionFolderSubtreeIds(metadata.folders, folder.id)) {
        projectSubtreeIds.add(id)
      }
    }
  }
  if (projectSubtreeIds.size === 0) {
    return groups
  }
  return groups.filter(
    (g) => !(g.kind === 'folder' && g.folder && projectSubtreeIds.has(g.folder.id))
  )
}

export const SidebarProjectsSection = React.memo(function SidebarProjectsSection({
  query = '',
  showArchived = false,
  archivedKeys
}: {
  query?: string
  showArchived?: boolean
  archivedKeys?: ReadonlySet<string>
} = {}) {
  const activeView = useAppStore((s) => s.activeView)
  const activeProjectFolderId = useAppStore((s) => s.activeProjectFolderId)
  const openProjectsPage = useAppStore((s) => s.openProjectsPage)
  const openProjectPage = useAppStore((s) => s.openProjectPage)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)

  const metadata = useSessionFolders((s) => s.metadata)
  const locallyArchived = useSessionSidebarView((s) => s.archived)
  const deletedKeys = useSessionSidebarView((s) => s.view.deleted ?? [])
  const sessions = useSidebarSessions()

  const [sectionOpen, setSectionOpen] = useState(true)
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(
    () => new Set(['7cf7cd75-4bac-4b2a-88c5-0c3e66f628bc'])
  )
  const [showAllThreadsProjects, setShowAllThreadsProjects] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null)
  const dragExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (dragExpandTimerRef.current) {
        clearTimeout(dragExpandTimerRef.current)
      }
    }
  }, [])

  const archivedSet = useMemo(() => {
    const set = new Set<string>(locallyArchived)
    if (archivedKeys) {
      for (const k of archivedKeys) {
        set.add(k)
      }
    }
    return set
  }, [locallyArchived, archivedKeys])

  const deletedSet = useMemo(() => new Set<string>(deletedKeys), [deletedKeys])

  const projects = useMemo(
    () =>
      metadata.folders.filter((folder) =>
        isSidebarProjectFolder(folder, metadata.folders, metadata.projects)
      ),
    [metadata.folders, metadata.projects]
  )

  const normalizedQuery = query.trim().toLowerCase()

  const sessionsByProject = useMemo(() => {
    const map = new Map<string, SidebarSession[]>()
    for (const folder of projects) {
      const subtree = sessionFolderSubtreeIds(metadata.folders, folder.id)
      const coordinatorKey = metadata.projects?.[folder.id]?.coordinator?.sessionKey ?? null
      const matched: SidebarSession[] = []
      for (const session of sessions) {
        const key = conversationViewKey(session)
        if (!key || deletedSet.has(key)) {
          continue
        }
        const isArchived = archivedSet.has(key)
        if (isArchived && !showArchived) {
          continue
        }
        const folderId = metadata.membership[key]
        if ((folderId && subtree.has(folderId)) || (coordinatorKey && key === coordinatorKey)) {
          if (normalizedQuery) {
            const title = (session.customTitle ?? session.label).toLowerCase()
            const folderMatches = folder.name.toLowerCase().includes(normalizedQuery)
            if (!title.includes(normalizedQuery) && !folderMatches) {
              continue
            }
          }
          matched.push(session)
        }
      }
      map.set(folder.id, matched)
    }
    return map
  }, [
    projects,
    metadata.folders,
    metadata.projects,
    metadata.membership,
    sessions,
    deletedSet,
    archivedSet,
    showArchived,
    normalizedQuery
  ])

  const toggleProject = (folderId: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    setExpandedProjects((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }

  const handleProjectDragOver = (folderId: string, event: React.DragEvent<HTMLElement>): void => {
    const kind =
      readSessionSidebarDragKind(event.dataTransfer.types) ?? getSessionSidebarDrag()?.kind ?? null
    if (kind !== 'row') {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    if (dragOverProjectId !== folderId) {
      setDragOverProjectId(folderId)
      if (!sectionOpen) {
        setSectionOpen(true)
      }
      if (dragExpandTimerRef.current) {
        clearTimeout(dragExpandTimerRef.current)
      }
      dragExpandTimerRef.current = setTimeout(() => {
        setExpandedProjects((prev) => {
          if (prev.has(folderId)) {
            return prev
          }
          const next = new Set(prev)
          next.add(folderId)
          return next
        })
      }, 350)
    }
  }

  const handleProjectDragLeave = (folderId: string, event: React.DragEvent<HTMLElement>): void => {
    const related = event.relatedTarget as Node | null
    if (related && event.currentTarget.contains(related)) {
      return
    }
    if (dragOverProjectId === folderId) {
      setDragOverProjectId(null)
    }
    if (dragExpandTimerRef.current) {
      clearTimeout(dragExpandTimerRef.current)
      dragExpandTimerRef.current = null
    }
  }

  const handleProjectDrop = (
    folderId: string,
    folderName: string,
    event: React.DragEvent<HTMLElement>
  ): void => {
    const inFlight = getSessionSidebarDrag()
    const payload = readSessionSidebarDrag(event.dataTransfer)
    const kind = payload?.kind ?? inFlight?.kind ?? null
    if (kind !== 'row') {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    setDragOverProjectId(null)
    if (dragExpandTimerRef.current) {
      clearTimeout(dragExpandTimerRef.current)
      dragExpandTimerRef.current = null
    }

    setExpandedProjects((prev) => {
      if (prev.has(folderId)) {
        return prev
      }
      const next = new Set(prev)
      next.add(folderId)
      return next
    })

    if (inFlight?.batch && inFlight.batch.sessionKeys.length > 0) {
      const moved = moveSessionSidebarBatch(inFlight.batch, { kind: 'row', folderId })
      clearSessionSidebarDrag()
      if (moved.sessions > 0) {
        toast.success(
          translate('projects.sidebar.movedBatch', 'Moved {{count}} sessions into {{project}}', {
            count: moved.sessions,
            project: folderName
          })
        )
      }
      return
    }

    const sessionKey =
      (payload?.kind === 'row' ? payload.sessionKey : null) ??
      (inFlight?.kind === 'row' ? inFlight.sessionKey : null)
    clearSessionSidebarDrag()
    if (sessionKey) {
      fileDroppedSession(sessionKey, folderId)
      toast.success(
        translate('projects.sidebar.movedSession', 'Moved session into {{project}}', {
          project: folderName
        })
      )
    }
  }

  const overviewActive = activeView === 'project' && !activeProjectFolderId

  return (
    <div
      className="mb-1.5 border-b border-worktree-sidebar-border/60 pb-1.5"
      data-sidebar-projects-section=""
    >
      <div className="flex h-7 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-worktree-sidebar-accent">
        <button
          type="button"
          onClick={() => setSectionOpen((v) => !v)}
          aria-label={translate('projects.sidebar.toggle', 'Toggle projects')}
          className="rounded p-1 text-muted-foreground hover:text-worktree-sidebar-foreground"
        >
          {sectionOpen ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={openProjectsPage}
          data-sidebar-projects-entry=""
          aria-current={overviewActive ? 'page' : undefined}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] font-semibold tracking-tight transition-colors',
            overviewActive
              ? 'text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/85 hover:text-worktree-sidebar-foreground'
          )}
        >
          <FolderKanban className="size-3.5 shrink-0 text-primary" />
          <span className="truncate">{translate('projects.nav', 'Projects')}</span>
          <span className="ml-auto rounded-full bg-worktree-sidebar-foreground/10 px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
            {projects.length}
          </span>
        </button>
        <button
          type="button"
          onClick={openProjectCreate}
          title={translate('projects.new', 'New project')}
          aria-label={translate('projects.new', 'New project')}
          data-sidebar-new-project=""
          className="rounded p-1 text-muted-foreground hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {sectionOpen ? (
        <ul className="mt-0.5 space-y-0.5" data-sidebar-projects-list="">
          {projects.map((folder) => {
            const settings = metadata.projects?.[folder.id]
            return (
              <SidebarProjectItem
                key={folder.id}
                folder={folder}
                isSelected={activeView === 'project' && activeProjectFolderId === folder.id}
                isExpanded={expandedProjects.has(folder.id) || Boolean(normalizedQuery)}
                isDragOver={dragOverProjectId === folder.id}
                projectSessions={sessionsByProject.get(folder.id) ?? []}
                showAll={showAllThreadsProjects.has(folder.id)}
                coordinatorKey={settings?.coordinator?.sessionKey ?? null}
                fleetCount={settings?.multiThreadFleet?.length ?? 0}
                archivedSet={archivedSet}
                agentStatusByPaneKey={agentStatusByPaneKey}
                onToggleExpand={(e) => toggleProject(folder.id, e)}
                onOpenProject={() => openProjectPage(folder.id)}
                onToggleShowAll={() =>
                  setShowAllThreadsProjects((prev) => {
                    const next = new Set(prev)
                    if (next.has(folder.id)) {
                      next.delete(folder.id)
                    } else {
                      next.add(folder.id)
                    }
                    return next
                  })
                }
                onDragOver={(e) => handleProjectDragOver(folder.id, e)}
                onDragLeave={(e) => handleProjectDragLeave(folder.id, e)}
                onDrop={(e) => handleProjectDrop(folder.id, folder.name, e)}
              />
            )
          })}
        </ul>
      ) : null}
    </div>
  )
})
