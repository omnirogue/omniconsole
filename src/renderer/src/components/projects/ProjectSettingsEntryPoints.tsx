import { PanelsTopLeft, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { SessionFolder } from '@/lib/session-folders'
import { useAppStore } from '@/store'
import { useSessionFolders } from '@/store/session-folders'
import { isProjectFolder } from '../../../../shared/session-project-folder'
import { openProjectSettings } from './project-settings-dialog-store'

const PROJECT_GROUP_PREFIX = 'by:project:'

/** The project folder a Group-by project heading stands for; null for "No project". */
export function projectGroupFolderId(groupKey: string): string | null {
  if (!groupKey.startsWith(PROJECT_GROUP_PREFIX)) {
    return null
  }
  const folderId = groupKey.slice(PROJECT_GROUP_PREFIX.length)
  return folderId && folderId !== 'none' ? folderId : null
}

export function ProjectSettingsHeaderButton({
  groupKey,
  name
}: {
  groupKey: string
  name: string
}): React.JSX.Element | null {
  const folderId = projectGroupFolderId(groupKey)
  if (!folderId) {
    return null
  }
  const label = translate('projects.settings.openFor', 'Project settings for {{name}}', { name })
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="shrink-0 opacity-0 transition-opacity group-hover/session-header:opacity-100 focus-visible:opacity-100"
      data-project-settings-open={folderId}
      onClick={() => openProjectSettings(folderId)}
    >
      <Settings2 className="size-3.5" />
    </Button>
  )
}

/** A folder heading's way to its page; every project folder has one, set up or not. */
export function ProjectOpenHeaderButton({
  folder,
  folders
}: {
  folder: SessionFolder
  folders: readonly SessionFolder[]
}): React.JSX.Element | null {
  const openProjectPage = useAppStore((state) => state.openProjectPage)
  if (!isProjectFolder(folders, folder.id)) {
    return null
  }
  const label = translate('projects.open.for', 'Open project {{name}}', { name: folder.name })
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="shrink-0 opacity-0 transition-opacity group-hover/session-header:opacity-100 focus-visible:opacity-100"
      data-project-open={folder.id}
      onClick={() => openProjectPage(folder.id)}
    >
      <PanelsTopLeft className="size-3.5" />
    </Button>
  )
}

export function ProjectOpenMenuItem({
  folder,
  folders
}: {
  folder: SessionFolder
  folders: readonly SessionFolder[]
}): React.JSX.Element | null {
  const openProjectPage = useAppStore((state) => state.openProjectPage)
  if (!isProjectFolder(folders, folder.id)) {
    return null
  }
  return (
    <DropdownMenuItem data-project-open-menu="" onSelect={() => openProjectPage(folder.id)}>
      <PanelsTopLeft className="size-3.5" />
      {translate('projects.open.menu', 'Open project')}
    </DropdownMenuItem>
  )
}

/** A folder menu's entry: set a project folder up, or edit the settings it has. */
export function ProjectSettingsMenuItem({
  folder,
  folders
}: {
  folder: SessionFolder
  folders: readonly SessionFolder[]
}): React.JSX.Element | null {
  const configured = useSessionFolders((state) => Boolean(state.metadata.projects?.[folder.id]))
  if (!isProjectFolder(folders, folder.id)) {
    return null
  }
  return (
    <DropdownMenuItem
      data-project-settings-menu={configured ? 'edit' : 'setup'}
      onSelect={() => openProjectSettings(folder.id)}
    >
      <Settings2 className="size-3.5" />
      {configured
        ? translate('projects.settings.menuEdit', 'Project settings…')
        : translate('projects.settings.menuSetup', 'Set up as project…')}
    </DropdownMenuItem>
  )
}
