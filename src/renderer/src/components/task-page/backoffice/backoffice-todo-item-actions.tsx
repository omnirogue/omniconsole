import { DoneButton } from '@/components/next-step/DoneButton'
import { invalidateBackofficeWork } from './backoffice-work-store'
import { Archive } from 'lucide-react'
import { UpNextSubject } from '@/components/next-action/UpNextSubject'
import { Button } from '@/components/ui/button'
import { describeReturn, hoursUntil, waitLaterKeyForCard } from '@/lib/wait-later'
import { useWaitingUntil } from '@/store/wait-later-store'
import { translate } from '@/i18n/i18n'
import type { BackofficeTodoItem } from '../../../../../shared/backoffice-work-types'
import { HandoffQuestionAnswer, isAnswerableHandoffQuestion } from './HandoffQuestionAnswer'

export type BackofficeTodoItemActionsProps = {
  item: BackofficeTodoItem
  onUseItem?: (item: BackofficeTodoItem) => void
  onArchiveItem: (item: BackofficeTodoItem) => void
  archivePending: string | null
}

/** Visible task actions use the current handoff and revision-checked completion flows. */
export function BackofficeTodoItemActions({
  item,
  onArchiveItem,
  archivePending
}: BackofficeTodoItemActionsProps): React.JSX.Element {
  const until = useWaitingUntil()[waitLaterKeyForCard(item.task_id)]
  const waiting = until
    ? translate('nextStep.snoozedChip', 'Snoozed · {{hours}}h · Returns at {{when}}', {
        hours: hoursUntil(new Date(until), new Date()),
        when: describeReturn(new Date(until), new Date())
      })
    : null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {waiting ? <span className="text-xs text-muted-foreground">{waiting}</span> : null}
      <div className="w-full">
        <UpNextSubject subject={{ kind: 'card', item }} onChanged={invalidateBackofficeWork} />
        {/* Why not Complete: a done entry cannot close an agent's open question; only its answer does. */}
        {isAnswerableHandoffQuestion(item) ? (
          <HandoffQuestionAnswer key={item.decision_id} item={item} />
        ) : (
          <DoneButton
            subject={{ kind: 'card', item }}
            onDone={invalidateBackofficeWork}
            visibleLabel={translate('chatActions.complete', 'Complete')}
          />
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={archivePending !== null}
        onClick={() => onArchiveItem(item)}
        title={translate(
          'auto.components.TaskPage.backofficeArchiveHint',
          'Archive this task — it leaves your list; nothing is deleted.'
        )}
      >
        <Archive className="mr-1 size-3.5" />
        {archivePending === item.task_id
          ? translate('auto.components.TaskPage.backofficeArchiving', 'Archiving…')
          : translate('auto.components.TaskPage.backofficeArchive', 'Archive')}
      </Button>
    </div>
  )
}
