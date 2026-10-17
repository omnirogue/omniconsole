import { FolderPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  ProjectOpenHeaderButton,
  ProjectSettingsHeaderButton
} from '@/components/projects/ProjectSettingsEntryPoints'
import { SessionFolderNamePopover } from './SessionFolderNamePopover'
import { SavedSubfolderButton } from './SavedFolderControls'
import { SessionSidebarGroupMenu } from './SessionSidebarGroupMenu'
import { GroupPutAwayItem } from './GroupPutAwayItem'
import { SavedShowAllButton } from './SavedShowAllButton'
import { groupHeaderActionsClass } from './session-folder-layout-classes'
import type { SessionSidebarGroupProps } from './SessionSidebarGroup'

/**
 * The controls at the end of a group heading: saved-folder buttons, the rename anchor, the
 * put-away item, and the hover actions (subfolder, the folder's own "+", project settings, menu).
 */
export function SessionSidebarGroupHeaderActions(
  props: SessionSidebarGroupProps & {
    renameOpen: boolean
    onRenameOpenChange: (open: boolean) => void
  }
): React.JSX.Element | null {
  const { group, folders, onToggle, onHide, renameOpen, onRenameOpenChange } = props
  // Why: a paired owner's folder not received here yet has nothing this computer may edit.
  if (group.readOnlyOwnerFolder) {
    return null
  }
  return (
    <>
      {group.kind === 'saved' ? <SavedShowAllButton folders={folders} /> : null}
      {group.kind === 'saved' && props.onCreateSavedFolder ? (
        <SessionFolderNamePopover
          folders={folders}
          onSave={(name) => {
            const created = props.onCreateSavedFolder!(name)
            if (created && group.collapsed) {
              onToggle(group.key)
            }
            return created
          }}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={translate('conversations.newSavedFolder', 'New saved sessions folder')}
          >
            <FolderPlus className="size-3.5" />
          </Button>
        </SessionFolderNamePopover>
      ) : null}
      {group.folder ? (
        <SessionFolderNamePopover
          folder={group.folder}
          folders={folders}
          open={renameOpen}
          onOpenChange={onRenameOpenChange}
          onSave={(name) => props.onRenameFolder(group.folder!, name)}
        >
          {/* Why: an invisible anchor lets the rename editor open from the menu while positioning against the header. */}
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-6 w-px" />
        </SessionFolderNamePopover>
      ) : null}
      {group.kind === 'archived' ? (
        <GroupPutAwayItem
          group={group}
          folders={folders}
          routineCommands={props.routineCommands}
          inline
        />
      ) : null}
      <span className={groupHeaderActionsClass(group)} data-session-group-actions="">
        {group.folder?.section === 'saved' && props.onCreateSavedFolder ? (
          <SavedSubfolderButton
            folder={group.folder}
            folders={folders}
            onCreate={props.onCreateSavedFolder}
            onCreated={group.collapsed ? () => onToggle(group.key) : undefined}
          />
        ) : null}
        {/* Why saved folders too: a live row there still shows in it, and asks move it to Needs you. */}
        {group.kind === 'folder' && group.folder
          ? props.folderLauncher?.(group.folder, group.label)
          : null}
        {group.kind === 'folder' && group.folder ? (
          <ProjectOpenHeaderButton folder={group.folder} folders={folders} />
        ) : null}
        <ProjectSettingsHeaderButton groupKey={group.key} name={group.label} />
        <SessionSidebarGroupMenu
          routineCommands={props.routineCommands}
          group={group}
          folders={folders}
          onStartRename={() => onRenameOpenChange(true)}
          onDeleteFolder={props.onDeleteFolder}
          onHide={onHide}
          onSelectGroup={props.onSelectGroup}
        />
      </span>
    </>
  )
}
