import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { useConsoleTask } from '@/components/console-workflows/TaskNextActionEditor'
import { translate } from '@/i18n/i18n'
import { cardRow, type WorkRow } from '../../../../../shared/backoffice-work-views'
import { BackofficeWorkDetail } from './backoffice-work-detail'
import type { BackofficeTodoItemActionsProps } from './backoffice-todo-item-actions'

const EMPTY_ROWS: readonly WorkRow[] = []
const EMPTY_NAMES: ReadonlyMap<string, string> = new Map()

type TaskSheetProps = {
  taskId: string
  boardCard?: WorkCard
  scope: string
  onClose: () => void
  onChanged?: () => void
  initiallyEdit?: boolean
  rows?: readonly WorkRow[]
  viewer?: string | null
  names?: ReadonlyMap<string, string>
  baseUrl?: string | null
  itemActions?: Omit<BackofficeTodoItemActionsProps, 'item'>
}

/** Keep the originating board or calendar mounted while task details and linked work are open. */
export function BackofficeWorkTaskSheet(props: TaskSheetProps): React.JSX.Element {
  const [taskId, setTaskId] = useState(props.taskId)
  return (
    <Sheet open onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent className="w-full sm:max-w-2xl" data-work-task-sheet={taskId}>
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>{translate('tasks.taskDetails', 'Task details')}</SheetTitle>
          <SheetDescription>
            {translate(
              'tasks.detailsInPlace',
              'Edit the outcome, add notes, and follow the work here.'
            )}
          </SheetDescription>
        </SheetHeader>
        <TaskSheetContent
          {...props}
          key={`${props.scope}:${taskId}`}
          taskId={taskId}
          initiallyEdit={props.initiallyEdit && taskId === props.taskId}
          onOpenTask={setTaskId}
        />
      </SheetContent>
    </Sheet>
  )
}

function TaskSheetContent({
  taskId,
  boardCard,
  scope,
  onChanged,
  onOpenTask,
  rows = EMPTY_ROWS,
  viewer = null,
  names = EMPTY_NAMES,
  baseUrl = null,
  itemActions,
  initiallyEdit = false
}: TaskSheetProps & { onOpenTask: (taskId: string) => void }): React.JSX.Element {
  const { task, error, loading, refresh } = useConsoleTask(taskId)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const relatedRows = rows.filter((row) => row.taskId === taskId && row.thread)
  const selected = relatedRows.find((row) => row.key === selectedKey)
  const snapshot = boardCard?.id === taskId ? boardCard : undefined
  const metadata =
    snapshot && (!task || (snapshot.state_revision ?? -1) > (task.state_revision ?? -1))
      ? snapshot
      : task
  const card =
    task && metadata
      ? {
          ...task,
          status: metadata.status,
          kanban_status: metadata.kanban_status,
          tags: metadata.tags,
          company_slug: metadata.company_slug
        }
      : (task ?? snapshot ?? null)
  const row = selected ?? cardRow(taskId, card, viewer)
  const changed = (): void => {
    void refresh()
    onChanged?.()
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
      {selected && (
        <Button
          variant="ghost"
          size="sm"
          className="ml-4 mt-3"
          onClick={() => setSelectedKey(null)}
        >
          {translate('tasks.backToTask', 'Back to task')}
        </Button>
      )}
      <BackofficeWorkDetail
        row={row}
        scope={scope}
        baseUrl={baseUrl}
        viewer={viewer}
        names={names}
        itemActions={itemActions}
        initiallyEdit={initiallyEdit}
        cardError={error}
        relatedRows={relatedRows}
        onSelectRow={setSelectedKey}
        onOpenTask={(id) => {
          setSelectedKey(null)
          if (id === taskId) {
            changed()
          } else {
            onOpenTask(id)
          }
        }}
        onKeepRow={(key) => {
          setSelectedKey(key)
          changed()
        }}
        markRead={selected !== undefined}
      />
      {error && (
        <Button
          variant="outline"
          size="sm"
          className="mb-4 ml-4"
          disabled={loading}
          onClick={() => void refresh()}
        >
          {translate('tasks.reloadDetails', 'Reload saved task')}
        </Button>
      )}
    </div>
  )
}
