import { useState } from 'react'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { BackofficeWorkBoard } from './backoffice-work-board'
import { BackofficeWorkTaskSheet } from './backoffice-work-task-sheet'
import type { BackofficeTodoItemActionsProps } from './backoffice-todo-item-actions'

export function BackofficeWorkBoardWorkspace({
  scope,
  rows,
  viewer,
  names,
  baseUrl,
  itemActions,
  onRefresh
}: {
  scope: string
  rows: readonly WorkRow[]
  viewer: string | null
  names: ReadonlyMap<string, string>
  baseUrl: string | null
  itemActions: Omit<BackofficeTodoItemActionsProps, 'item'>
  onRefresh: () => void
}): React.JSX.Element {
  const [task, setTask] = useState<{ id: string; edit?: boolean; card?: WorkCard } | null>(null)
  const [revision, setRevision] = useState(0)
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
      <BackofficeWorkBoard
        key={scope}
        scope={scope}
        rows={rows}
        viewer={viewer}
        names={names}
        refreshKey={revision}
        onOpenTask={(id, card) => setTask({ id, card })}
        onEditTask={(id, card) => setTask({ id, card, edit: true })}
      />
      {task && (
        <BackofficeWorkTaskSheet
          key={`${scope}:${task.id}`}
          taskId={task.id}
          boardCard={task.card}
          initiallyEdit={task.edit}
          scope={scope}
          rows={rows}
          viewer={viewer}
          names={names}
          baseUrl={baseUrl}
          itemActions={itemActions}
          onChanged={() => setRevision((value) => value + 1)}
          onClose={() => {
            setTask(null)
            setRevision((value) => value + 1)
            onRefresh()
          }}
        />
      )}
    </div>
  )
}
