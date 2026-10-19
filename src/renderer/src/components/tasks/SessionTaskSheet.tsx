import { translate } from '@/i18n/i18n'
import { useSessionTasks } from '@/store/session-task-store'
import { consoleJiraIssueUrl } from '../../../../shared/console-jira-work-contract'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { BackofficeWorkTaskSheet } from '@/components/task-page/backoffice/backoffice-work-task-sheet'
import { useBackofficeWorkViews } from '@/components/task-page/backoffice/backoffice-work-store'
import { valueOf } from '@/components/task-page/backoffice/backoffice-work-reads'

function LegacySessionTaskSheet({
  taskId,
  scope,
  onClose,
  onChanged
}: {
  taskId: string
  scope: string
  onClose: () => void
  onChanged?: () => void
}): React.JSX.Element {
  const work = useBackofficeWorkViews(scope, true)
  const todo = valueOf(work.reads.todo)
  return (
    <BackofficeWorkTaskSheet
      taskId={taskId}
      scope={scope}
      names={work.names}
      rows={work.views.all}
      viewer={todo?.employeeId ?? null}
      baseUrl={todo?.baseUrl ?? null}
      onClose={onClose}
      onChanged={onChanged}
    />
  )
}

export function SessionTaskSheet(
  props: Parameters<typeof LegacySessionTaskSheet>[0]
): React.JSX.Element {
  const links = useSessionTasks((state) => state.links)
  if (!props.taskId.startsWith('jira:')) {
    return <LegacySessionTaskSheet {...props} />
  }
  const link = Object.values(links).find(
    (value) => value.taskId === props.taskId && value.accountScope === props.scope
  )
  const url = link?.workRef ? consoleJiraIssueUrl(link.workRef) : null
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {link?.workRef?.issue_key ?? translate('tasks.jira.task', 'Jira task')}
          </DialogTitle>
          <DialogDescription>
            {link?.title ??
              translate(
                'tasks.jira.openDetails',
                'Open the shared task to view its current details.'
              )}
          </DialogDescription>
        </DialogHeader>
        <Button
          onClick={() =>
            void window.api.shell.openUrl(url ?? 'https://console.example.com/work/jira')
          }
        >
          {translate('tasks.jira.openTask', 'Open Jira task')}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
