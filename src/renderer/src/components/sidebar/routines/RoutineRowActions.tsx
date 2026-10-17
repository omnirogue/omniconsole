import { ConvertRoutineToTeamDialog } from './ConvertRoutineToTeamDialog'
import { makeRoutineTeam } from './routine-row-commands'
import { useRoutineTeamLink } from './routine-team-links'
import { routineTeamCopy as copy } from './routine-team-copy'
import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Folder,
  FolderMinus,
  MoreVertical,
  Pause,
  Play,
  PlayCircle,
  Settings2,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import type { Automation } from '../../../../../shared/automations-types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SessionFolder } from '@/lib/session-folders'
import { sessionFolderPath, sessionFolderTree } from '@/lib/session-folder-tree'
import { useAppStore } from '@/store'
import { PersonalHideButton } from '../session-folders/PersonalHideButton'
import { RoutineSharePopover } from './RoutineSharePopover'
import { RoutineDeleteDialog, skipsRoutineDeleteConfirm } from './RoutineDeleteDialog'
import { RoutineSchedulePopover } from './RoutineSchedulePopover'
import type { RoutineCommands } from './routine-row-commands'
import {
  archiveSessionsByPerson,
  moveSessionsByPerson
} from '@/lib/session-organization-person-changes'
import { useRoutineSidebarView } from './routine-sidebar-stores'
import { setRoutineRowsHidden } from '../session-folders/sidebar-group-and-routine-hiding'

function IconAction({
  label,
  onClick,
  children,
  ref
}: {
  label: string
  onClick?: () => void
  children: React.ReactNode
  ref?: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button ref={ref} variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The hover cluster at the right edge of a routine row: 👁 🗄 ⏸/▶ 🕒 ⋮. */
export function RoutineRowActions({
  automation,
  routineKey,
  hidden,
  folders,
  folderId,
  commands
}: {
  automation: Automation
  routineKey: string
  hidden: boolean
  folders: readonly SessionFolder[]
  folderId: string | null
  commands: RoutineCommands
}): React.JSX.Element {
  const archivedByHand = useRoutineSidebarView((state) => state.archived.includes(routineKey))
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const link = useRoutineTeamLink(automation.id)
  const openConversion = (): void => makeRoutineTeam(automation, () => setConvertOpen(true))
  const name = automation.name
  const openSettings = (): void => {
    const state = useAppStore.getState()
    state.setSelectedAutomationId(automation.id)
    state.openAutomationsPage()
  }
  const toggleArchived = async (): Promise<void> => {
    if (archivedByHand) {
      // Why: unarchiving hands the routine back as it was left — paused until the person resumes it.
      archiveSessionsByPerson([routineKey], false)
      return
    }
    archiveSessionsByPerson([routineKey], true)
    if (automation.enabled && (await commands.setEnabled(automation, false))) {
      toast.success(translate('routines.archivedAndPaused', 'Archived and paused'))
    }
  }
  return (
    <>
      {link && link.state !== 'linked' ? (
        <Button variant="link" size="xs" className="text-destructive" onClick={openConversion}>
          {link.state === 'pending' ? copy.retryEnable() : copy.retry()}
        </Button>
      ) : null}
      <span
        className="flex opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        data-routine-row-actions=""
      >
        <PersonalHideButton
          hidden={hidden}
          name={name}
          onClick={() => setRoutineRowsHidden([routineKey], !hidden)}
        />
        <IconAction
          label={
            archivedByHand
              ? translate('conversations.unarchiveItem', 'Unarchive {{name}}', {
                  name
                })
              : translate('conversations.archiveItem', 'Archive {{name}}', {
                  name
                })
          }
          onClick={() => void toggleArchived()}
        >
          {archivedByHand ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
        </IconAction>
        <IconAction
          label={
            automation.enabled
              ? translate('routines.pauseItem', 'Pause {{name}}', { name })
              : translate('routines.resumeItem', 'Resume {{name}}', { name })
          }
          onClick={() => void commands.setEnabled(automation, !automation.enabled)}
        >
          {automation.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </IconAction>
        <RoutineSchedulePopover
          automation={automation}
          onSave={(updates) => commands.update(automation, updates)}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translate('routines.scheduleItem', 'Schedule for {{name}}', { name })}
          >
            <CalendarClock className="size-3.5" />
          </Button>
        </RoutineSchedulePopover>
        <RoutineSharePopover name={name} onMakeTeam={openConversion} />
        <DropdownMenu>
          {/* Why no tooltip: closing the menu refocuses this and would pop one. */}
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate('routines.moreOptions', 'More options for {{name}}', { name })}
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={openConversion}>
              {link?.state === 'linked' ? copy.moved() : copy.action()}
            </DropdownMenuItem>
            {link && !automation.enabled ? (
              <DropdownMenuItem onSelect={() => void commands.setEnabled(automation, true)}>
                {copy.restore()}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={() => void commands.runNow(automation)}>
              <PlayCircle className="size-3.5" />
              {translate('routines.runNow', 'Run now')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={openSettings}>
              <Settings2 className="size-3.5" />
              {translate('routines.settings', 'Routine settings')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Folder className="size-3.5" />
                {translate('routines.moveToFolder', 'Move to folder…')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {sessionFolderTree(folders).map(({ folder }) => (
                  <DropdownMenuItem
                    key={folder.id}
                    disabled={folder.id === folderId}
                    onSelect={() => moveSessionsByPerson([routineKey], folder.id)}
                  >
                    <Folder className="size-3.5" />
                    {sessionFolderPath(folders, folder)}
                  </DropdownMenuItem>
                ))}
                {folders.length > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  disabled={folderId === null}
                  onSelect={() => moveSessionsByPerson([routineKey], null)}
                >
                  <FolderMinus className="size-3.5" />
                  {translate('routines.noFolder', 'No folder')}
                </DropdownMenuItem>
                {folders.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    {translate('routines.noFoldersYet', 'Create a folder from the list header.')}
                  </p>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                if (skipsRoutineDeleteConfirm()) {
                  void commands.remove(automation)
                } else {
                  setDeleteOpen(true)
                }
              }}
            >
              <Trash2 className="size-3.5" />
              {translate('routines.delete', 'Delete routine')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
      {convertOpen ? (
        <ConvertRoutineToTeamDialog
          automation={automation}
          commands={commands}
          onClose={() => setConvertOpen(false)}
        />
      ) : null}
      <RoutineDeleteDialog
        automation={automation}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={() => void commands.remove(automation)}
      />
    </>
  )
}
