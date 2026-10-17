import React from 'react'
import { ChevronsDownUp, ChevronsUpDown, FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import { translate } from '@/i18n/i18n'
import {
  getBulkCollapsedGroupKeys,
  useSidebarCollapsibleGroupKeys,
  useSidebarDefaultCollapsedGroupKeys
} from './sidebar-collapsible-groups'
import { SESSION_LINEAGE_OPEN_PREFIX } from './worktree-list/grouping/group-keys'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange
}: SidebarHeaderProps) {
  const openModal = useAppStore((s) => s.openModal)
  const newWorktreeShortcutLabel = useShortcutLabel('workspace.create')
  const groupBy = useAppStore((s) => s.groupBy)
  const sidebarTitle = groupBy === 'repo' ? 'Projects' : 'Workspaces'
  const collapsibleGroupKeys = useSidebarCollapsibleGroupKeys()
  const defaultCollapsedKeys = useSidebarDefaultCollapsedGroupKeys()
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const setCollapsedGroups = useAppStore((s) => s.setCollapsedGroups)
  // Why: one control toggles between the two bulk states; expand wins while anything is still open.
  const anyExpanded =
    collapsibleGroupKeys.some((key) => !collapsedGroups.has(key)) ||
    defaultCollapsedKeys.some((key) => collapsedGroups.has(key))
  const collapseAllLabel = translate(
    'auto.components.sidebar.SidebarHeader.collapseAll',
    'Collapse all'
  )
  const expandAllLabel = translate('auto.components.sidebar.SidebarHeader.expandAll', 'Expand all')
  const toggleAllGroups = (): void => {
    setCollapsedGroups(
      getBulkCollapsedGroupKeys({
        collapse: anyExpanded,
        collapsibleGroupKeys,
        defaultCollapsedKeys,
        storedCollapsedGroups: collapsedGroups,
        isOpenPolarityKey: (key) => key.startsWith(SESSION_LINEAGE_OPEN_PREFIX)
      })
    )
  }

  return (
    <div className="mt-2 flex h-8 items-center justify-between px-2 gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <span
          className="pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none"
          data-sidebar-section-title={groupBy === 'repo' ? 'projects' : 'workspaces'}
        >
          {sidebarTitle}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {collapsibleGroupKeys.length > 0 || defaultCollapsedKeys.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={anyExpanded ? collapseAllLabel : expandAllLabel}
                data-sidebar-collapse-all={anyExpanded ? 'collapse' : 'expand'}
                onClick={toggleAllGroups}
              >
                {anyExpanded ? (
                  <ChevronsDownUp className="size-3.5" strokeWidth={2.25} />
                ) : (
                  <ChevronsUpDown className="size-3.5" strokeWidth={2.25} />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {anyExpanded ? collapseAllLabel : expandAllLabel}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <SidebarWorkspaceOptionsMenu
          preserveWorkspaceBoardOpen
          onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={translate(
                'auto.components.sidebar.SidebarHeader.25a95899c9',
                'Add Project'
              )}
              onClick={() => openModal('add-repo')}
            >
              <FolderPlus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.sidebar.SidebarHeader.25a95899c9', 'Add Project')}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              // Why: the parallel-work tour must click the real sidebar
              // control so it can hand off to the workspace-creation tour.
              onClick={openWorkspaceCreationComposerWithTourHandoff}
              aria-label={translate(
                'auto.components.sidebar.SidebarHeader.92154beb7e',
                'New workspace'
              )}
              data-contextual-tour-target="workspace-create-control"
            >
              <Plus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>
            {translate(
              'auto.components.sidebar.SidebarHeader.ca6f729da2',
              'New workspace ({{value0}})',
              { value0: newWorktreeShortcutLabel }
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarHeader
