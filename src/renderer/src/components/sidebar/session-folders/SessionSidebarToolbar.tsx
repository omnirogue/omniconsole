import { FolderKanban, FolderPlus } from 'lucide-react'
import { openProjectCreate } from '@/components/projects/project-settings-dialog-store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ConversationRoutineGroup } from '@/lib/conversation-routine-rows'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import {
  sessionSidebarGroupBy,
  type SessionSidebarGroupBy,
  type SessionSidebarView
} from '@/lib/session-sidebar-view'
import { NewConversationButton } from './NewConversationButton'
import { SessionAutoCollapseMenu } from './SessionAutoCollapseMenu'
import { SessionCollapseAllButton } from './SessionCollapseAllButton'
import { SessionFilterMenu } from './SessionFilterMenu'
import { SessionFolderNamePopover } from './SessionFolderNamePopover'
import { SessionGridButton } from './SessionGridButton'
import { SessionGroupByMenu } from './SessionGroupByMenu'
import { SessionGroupByTaskToggle } from './SessionGroupByTaskToggle'
import { sidebarFolderEdits } from './session-sidebar-folder-edits'
import { sessionSidebarViewChoice } from '@/lib/session-sidebar-view-choice'

/** The row of list controls above the Conversations list. */
export function SessionSidebarToolbar(props: {
  observedSessions: readonly SidebarSession[]
  groups: readonly ConversationRoutineGroup[]
  currentKeys: readonly string[]
  listRef: React.RefObject<HTMLElement | null>
  folders: {
    metadata: SessionFolderMetadata
    loaded: boolean
    createFolder: (name: string) => unknown
  }
  viewStore: {
    view: SessionSidebarView
    setGroupBy: (groupBy: SessionSidebarGroupBy) => void
    setCollapsed: (keys: readonly string[], collapsed: boolean) => void
  }
}): React.JSX.Element {
  const { folders, viewStore, groups } = props
  const flat = sessionSidebarViewChoice(viewStore.view) === 'flat'
  return (
    <div className="flex flex-wrap items-center justify-end gap-0.5">
      <SessionFilterMenu />
      {flat ? null : (
        <SessionGroupByTaskToggle
          pressed={sessionSidebarGroupBy(viewStore.view) === 'task'}
          onPressedChange={(pressed) => viewStore.setGroupBy(pressed ? 'task' : 'status')}
        />
      )}
      <SessionGroupByMenu />
      <SessionGridButton />
      {flat ? null : (
        <>
          <SessionAutoCollapseMenu
            groups={groups}
            currentKeys={props.currentKeys}
            listRef={props.listRef}
            metadata={folders.metadata}
          />
          <SessionCollapseAllButton
            groups={groups}
            folders={folders.metadata.folders}
            onSetCollapsed={viewStore.setCollapsed}
          />
          <SessionFolderNamePopover
            folders={folders.metadata.folders}
            onSave={(name) => sidebarFolderEdits.create(name) !== null}
          >
            <Button
              size="icon-xs"
              variant="ghost"
              className="text-muted-foreground"
              disabled={!folders.loaded}
              aria-label={translate('auto.components.SessionSidebar.newFolder', 'New folder')}
            >
              <FolderPlus className="size-3.5" />
            </Button>
          </SessionFolderNamePopover>
        </>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground"
        disabled={!folders.loaded}
        aria-label={translate('projects.create.open', 'New project')}
        title={translate('projects.create.open', 'New project')}
        data-session-project-create=""
        onClick={openProjectCreate}
      >
        <FolderKanban className="size-3.5" />
      </Button>
      <NewConversationButton />
    </div>
  )
}
