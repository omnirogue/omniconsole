import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { allSessionGroupKeys } from '@/lib/saved-session-sidebar-groups'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'

/** Folds every group (folders nested out of sight included) while any is open; else opens all. */
export function SessionCollapseAllButton({
  groups,
  folders,
  onSetCollapsed
}: {
  groups: readonly SessionSidebarGroup[]
  folders: readonly SessionFolder[]
  onSetCollapsed: (keys: readonly string[], collapsed: boolean) => void
}): React.JSX.Element {
  const anyExpanded = groups.some((group) => !group.collapsed)
  const collapseAllLabel = translate('auto.components.SessionSidebar.collapseAll', 'Collapse all')
  const expandAllLabel = translate('auto.components.SessionSidebar.expandAll', 'Expand all')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          disabled={groups.length === 0}
          aria-label={anyExpanded ? collapseAllLabel : expandAllLabel}
          onClick={() => onSetCollapsed(allSessionGroupKeys(groups, folders), anyExpanded)}
        >
          {anyExpanded ? (
            <ChevronsDownUp className="size-3.5" />
          ) : (
            <ChevronsUpDown className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{anyExpanded ? collapseAllLabel : expandAllLabel}</TooltipContent>
    </Tooltip>
  )
}
