import { useRef } from 'react'
import {
  CalendarClock,
  CheckCheck,
  Eye,
  EyeOff,
  MoreHorizontal,
  Pencil,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import { SavedFolderMoveMenu } from './SavedFolderControls'
import { SessionFolderColorMenu } from './SessionFolderColorMenu'
import { GroupPutAwayItem } from './GroupPutAwayItem'
import { SessionFolderAutomationItem } from './SessionFolderAutomationItem'
import {
  ProjectOpenMenuItem,
  ProjectSettingsMenuItem
} from '@/components/projects/ProjectSettingsEntryPoints'
import type { SessionGroupSelectMode } from './use-session-group-select'
import type { SidebarCleanupGroup } from './sidebar-cleanup-rows'
import type { RoutineCommands } from '../routines/routine-row-commands'

/** Groups a person files things into can take a color; the automatic status groups cannot. */
export function isColorableSessionGroup(group: Pick<SessionSidebarGroup, 'kind' | 'folder'>) {
  return group.kind === 'saved' || group.folder !== undefined
}

/** The ⋯ on a group heading: select what is in it, color it, and manage the folder itself. */
export function SessionSidebarGroupMenu({
  group,
  folders,
  onStartRename,
  onDeleteFolder,
  onHide,
  onSelectGroup,
  routineCommands
}: {
  group: SidebarCleanupGroup
  routineCommands?: Pick<RoutineCommands, 'setEnabled'>
  folders: readonly SessionFolder[]
  onStartRename: () => void
  onDeleteFolder: (folder: SessionFolder) => void
  onHide: (key: string, hidden: boolean) => void
  onSelectGroup?: (group: SessionSidebarGroup, mode: SessionGroupSelectMode) => void
}): React.JSX.Element | null {
  // Why a ref: the menu's close-focus handler runs after the item fires, and must know a rename just started.
  const renameStartedRef = useRef(false)
  const count =
    group.rows.length +
    (group.childRowCount ?? 0) +
    (group.fleetRows?.length ?? 0) +
    (group.routineRows?.length ?? 0)
  // Why not Needs you: it is answered row by row, and deliberately carries no menu.
  const selectable = onSelectGroup !== undefined && count > 0 && group.kind !== 'attention'
  const colorable = isColorableSessionGroup(group)
  if (!group.canHide && !group.folder && !colorable && !selectable) {
    return null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 opacity-0 transition-opacity group-hover/session-header:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          aria-label={translate(
            'auto.components.SessionSidebar.groupOptions',
            'Options for {{group}}',
            { group: group.label }
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          if (renameStartedRef.current) {
            renameStartedRef.current = false
            event.preventDefault()
          }
        }}
      >
        {selectable ? (
          <>
            <DropdownMenuItem
              data-session-group-select="all"
              onSelect={() => onSelectGroup(group, 'all')}
            >
              <CheckCheck className="size-3.5" />
              {translate('conversations.selectAllInGroup', 'Select all ({{count}})', { count })}
            </DropdownMenuItem>
            <GroupPutAwayItem group={group} folders={folders} routineCommands={routineCommands} />
            {group.kind === 'archived' ? (
              <DropdownMenuItem
                data-session-group-select="archived-older"
                onSelect={() => onSelectGroup(group, 'archived-older')}
              >
                <CalendarClock className="size-3.5" />
                {translate('conversations.selectArchivedOlder', 'Select archived over 7 days ago')}
              </DropdownMenuItem>
            ) : null}
            {colorable || group.folder || group.canHide ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {colorable ? <SessionFolderColorMenu groupKey={group.key} /> : null}
        {group.folder ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                renameStartedRef.current = true
                onStartRename()
              }}
            >
              <Pencil className="size-3.5" />
              {translate('auto.components.SessionSidebar.rename', 'Rename')}
            </DropdownMenuItem>
            {group.folder.section === 'saved' ? (
              <SavedFolderMoveMenu folder={group.folder} folders={folders} />
            ) : null}
            <SessionFolderAutomationItem folderId={group.folder.id} />
            <ProjectOpenMenuItem folder={group.folder} folders={folders} />
            <ProjectSettingsMenuItem folder={group.folder} folders={folders} />
            <DropdownMenuItem onSelect={() => onDeleteFolder(group.folder!)}>
              <Trash2 className="size-3.5" />
              {translate('auto.components.SessionSidebar.deleteFolder', 'Delete folder')}
            </DropdownMenuItem>
          </>
        ) : null}
        {group.canHide ? (
          <>
            {group.folder || colorable ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={() => onHide(group.key, !group.hidden)}>
              {group.hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
              {group.hidden
                ? translate('auto.components.SessionSidebar.unhideGroup', 'Show in sidebar')
                : translate('auto.components.SessionSidebar.hideGroup', 'Hide from sidebar')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
