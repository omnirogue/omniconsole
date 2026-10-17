import React from 'react'
import { ArrowLeft, FolderKanban, MessageSquare, MessageSquarePlus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NewConversationButton } from '@/components/sidebar/session-folders/NewConversationButton'
import { translate } from '@/i18n/i18n'
import { openSidebarSession } from '@/lib/open-sidebar-session'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionProjectThread } from '@/lib/session-project-threads'
import { useAppStore } from '@/store'
import type { ProjectSettings } from '../../../../shared/project-settings'
import { openProjectSettings } from './project-settings-dialog-store'
import { SessionProjectJiraIssues } from './SessionProjectJiraIssues'
import { useProjectCoordinatorLaunch } from './use-project-coordinator-launch'

/** The page's top line: the way back, the project's name and place, and the ways to start work. */
export function SessionProjectHeader({
  folder,
  settings,
  company,
  coordinator
}: {
  folder: SessionFolder
  settings: ProjectSettings | null
  /** The company folder the project sits in, when it does. */
  company: SessionFolder | null
  /** The project's chat, while its session is listed; null means it has to be started. */
  coordinator: SessionProjectThread | null
}): React.JSX.Element {
  const openProjectsPage = useAppStore((state) => state.openProjectsPage)
  const chat = useProjectCoordinatorLaunch({ id: folder.id, name: folder.name }, settings)
  const place = [company?.name ?? settings?.company, settings?.domain].filter(Boolean).join(' · ')
  const settingsLabel = settings
    ? translate('projects.settings.menuEdit', 'Project settings…')
    : translate('projects.settings.menuSetup', 'Set up as project…')
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={openProjectsPage}
          aria-label={translate('projects.page.back', 'All projects')}
          title={translate('projects.page.back', 'All projects')}
        >
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <FolderKanban className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold" data-session-project-name={folder.name}>
            {folder.name}
          </h1>
          {place ? <p className="truncate text-xs text-muted-foreground">{place}</p> : null}
          {settings ? <SessionProjectJiraIssues folderId={folder.id} settings={settings} /> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {settings ? (
          coordinator ? (
            <Button
              size="sm"
              variant="ghost"
              data-session-project-chat="open"
              onClick={() => openSidebarSession(coordinator.row.session)}
            >
              <MessageSquare className="size-3.5" aria-hidden />
              {translate('projects.chat.open', 'Project chat')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              data-session-project-chat="start"
              disabled={chat.starting}
              onClick={chat.start}
            >
              <MessageSquarePlus className="size-3.5" aria-hidden />
              {chat.starting
                ? translate('projects.chat.starting', 'Starting…')
                : translate('projects.chat.start', 'Start coordinator')}
            </Button>
          )
        ) : null}
        {/* Why the folder's own "+": it already offers every provider, model, effort, Teams and the inherited context. */}
        <span
          data-session-project-new-thread=""
          title={translate('projects.page.newThread', 'New thread')}
        >
          <NewConversationButton folder={{ id: folder.id, name: folder.name }} />
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => openProjectSettings(folder.id)}
          aria-label={settingsLabel}
        >
          <Settings2 className="size-3.5" aria-hidden />
          {translate('projects.page.settings', 'Settings')}
        </Button>
      </div>
    </header>
  )
}
