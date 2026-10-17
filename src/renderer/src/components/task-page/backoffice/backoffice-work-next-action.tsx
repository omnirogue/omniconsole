import {
  TaskNextActionEditor,
  useConsoleTask
} from '@/components/console-workflows/TaskNextActionEditor'
import { WorkflowError } from '@/components/console-workflows/WorkflowFields'
import { translate } from '@/i18n/i18n'
import { invalidateBackofficeWork } from './backoffice-work-store'

/** The card's next action, editable where the card's row lives; the row's "What happens next" reads it. */
export function BackofficeWorkNextAction({ taskId }: { taskId: string }): React.JSX.Element {
  const { task, loading, error, refresh } = useConsoleTask(taskId)
  return (
    <section className="space-y-2" data-work-next-action={taskId}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {translate('backofficeWork.nextActionSection', 'Next action on the card')}
      </div>
      <WorkflowError message={error} />
      {loading && !task ? (
        <p className="text-xs text-muted-foreground">
          {translate('backofficeWork.nextActionLoading', 'Reading the card…')}
        </p>
      ) : null}
      <TaskNextActionEditor
        taskId={taskId}
        task={task}
        loading={loading}
        onSaved={async () => {
          // Why: the row's "What happens next" comes from the Todo feed, which the save changed.
          invalidateBackofficeWork()
          await refresh()
        }}
      />
    </section>
  )
}
