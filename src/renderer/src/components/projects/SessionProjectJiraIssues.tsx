import React, { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { AttachToTaskDialog } from '@/components/tasks/AttachToTaskDialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { setProjectSettingsByPerson } from '@/lib/session-organization-person-changes'
import {
  consoleJiraIssueUrl,
  type ConsoleJiraWorkRef
} from '../../../../shared/console-jira-work-contract'
import type { JiraSessionTask } from '../../../../shared/console-jira-session-contract'
import {
  PROJECT_MAX_TASKS,
  projectSettingsError,
  type ProjectSettings
} from '../../../../shared/project-settings'

const sameIssue = (a: ConsoleJiraWorkRef, b: ConsoleJiraWorkRef): boolean =>
  a.cloud_id === b.cloud_id && a.issue_id === b.issue_id

/** Saves the project's issue list as one recorded `folder.project` change; false when refused. */
export function saveProjectJiraIssues(
  folderId: string,
  settings: ProjectSettings,
  tasks: ConsoleJiraWorkRef[]
): boolean {
  const next: ProjectSettings = { ...settings, tasks }
  const error = projectSettingsError(next)
  if (error) {
    toast.error(error)
    return false
  }
  return setProjectSettingsByPerson(folderId, next)
}

/** The project's Jira issues in the page header; shown to the coordinator, never in a thread's brief. */
export function SessionProjectJiraIssues({
  folderId,
  settings
}: {
  folderId: string
  settings: ProjectSettings
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const tasks = settings.tasks ?? []
  const add = async (task: JiraSessionTask): Promise<boolean> => {
    if (tasks.some((ref) => sameIssue(ref, task.work_ref))) {
      return true
    }
    return saveProjectJiraIssues(folderId, settings, [...tasks, task.work_ref])
  }
  return (
    <div className="flex flex-wrap items-center gap-1" data-session-project-jira={tasks.length}>
      {tasks.map((ref) => {
        const url = consoleJiraIssueUrl(ref)
        return (
          <span
            key={`${ref.cloud_id}:${ref.issue_id}`}
            className="inline-flex items-center gap-0.5 rounded-full border py-px pr-0.5 pl-1.5 text-[10px] text-muted-foreground"
            data-session-project-jira-issue={ref.issue_key}
          >
            {url ? (
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => void window.api.shell.openUrl(url)}
              >
                {ref.issue_key}
              </button>
            ) : (
              ref.issue_key
            )}
            <button
              type="button"
              className="rounded-full p-0.5 hover:bg-accent hover:text-foreground"
              aria-label={translate('projects.jira.remove', 'Remove {{key}} from this project', {
                key: ref.issue_key
              })}
              onClick={() =>
                saveProjectJiraIssues(
                  folderId,
                  settings,
                  tasks.filter((other) => !sameIssue(other, ref))
                )
              }
            >
              <X className="size-2.5" aria-hidden />
            </button>
          </span>
        )
      })}
      {tasks.length < PROJECT_MAX_TASKS ? (
        <Button
          size="xs"
          variant="ghost"
          className="h-5 px-1.5 text-[10px] text-muted-foreground"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3" aria-hidden />
          {translate('projects.jira.add', 'Add issue')}
        </Button>
      ) : null}
      <AttachToTaskDialog session={null} open={adding} onOpenChange={setAdding} onSelect={add} />
    </div>
  )
}
