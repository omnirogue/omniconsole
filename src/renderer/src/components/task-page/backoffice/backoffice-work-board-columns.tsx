import { translate } from '@/i18n/i18n'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { WorkCard } from '../../../../../shared/console-work-home-contract'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import { BackofficeWorkCardMove } from './backoffice-work-card-move'
import { workKanbanColumns, type WorkColumn } from './work-kanban-presentation'

/**
 * Proposed plus the six outcome columns and their cards. Split out of the board so the
 * card's "Move to…" control has somewhere to live without the board outgrowing its budget.
 */
export function BackofficeWorkBoardColumns({
  cards,
  relatedByTask,
  columnOf,
  renderCard,
  onEditTask,
  onMoved,
  onMovePending
}: {
  cards: readonly WorkCard[]
  relatedByTask: ReadonlyMap<string, readonly WorkRow[]>
  columnOf: (card: WorkCard) => WorkColumn
  renderCard: (card: WorkCard) => React.JSX.Element
  onEditTask?: (taskId: string) => void
  /** A move landed: re-read the board so the card appears under its new column. */
  onMoved: (taskId: string, target: WorkColumn) => Promise<void>
  onMovePending: (card: WorkCard, pending: boolean) => void
}): React.JSX.Element {
  return (
    <div
      className="grid grid-cols-[minmax(8rem,0.75fr)_repeat(5,minmax(11rem,1fr))_minmax(8rem,0.75fr)] gap-3 overflow-x-auto"
      aria-label={translate('workKanban.columns', 'Work columns')}
    >
      {workKanbanColumns().map(({ state, label, description }) => {
        const inColumn = cards.filter((card) => columnOf(card) === state)
        return (
          <section key={state} className="min-w-0 space-y-2" data-work-column={state}>
            <h3 className="text-xs font-semibold">
              {label} · {inColumn.length}
            </h3>
            <p className="min-h-12 text-xs text-muted-foreground">{description}</p>
            {inColumn.map((card) => (
              <div key={card.id} className="space-y-1">
                {renderCard(card)}
                <div className="flex flex-wrap items-start gap-1">
                  {onEditTask && (
                    <Button variant="ghost" size="sm" onClick={() => onEditTask(card.id)}>
                      <Pencil className="size-3.5" />
                      {translate('tasks.editDetails', 'Edit task')}
                    </Button>
                  )}
                  <BackofficeWorkCardMove
                    card={card}
                    column={state}
                    todo={relatedByTask.get(card.id)?.find((row) => row.todo)?.todo ?? null}
                    onMoved={onMoved}
                    onPending={(pending) => onMovePending(card, pending)}
                  />
                </div>
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}
