import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { BackofficeWorkDetail } from '@/components/task-page/backoffice/backoffice-work-detail'
import { translate } from '@/i18n/i18n'
import type { CalendarHandoffDue } from './calendar-handoffs'

/** The thread behind a handoff due date, opened with the Work list's own detail, over the calendar. */
export function CalendarHandoffSheet({
  due,
  scope,
  names,
  onClose,
  onOpenTask
}: {
  due: CalendarHandoffDue
  scope: string
  names: ReadonlyMap<string, string>
  onClose: () => void
  onOpenTask: (taskId: string) => void
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-2xl" data-calendar-handoff-sheet={due.key}>
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>
            {due.ask === 'review'
              ? translate('calendar.reviewDue', 'Review due')
              : translate('calendar.handoffDue', 'Handoff due')}
          </SheetTitle>
          <SheetDescription>{due.row.title}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          <BackofficeWorkDetail
            row={due.row}
            scope={scope}
            baseUrl={null}
            names={names}
            viewer={due.viewerId}
            onOpenTask={onOpenTask}
            // Why: this sheet shows one fixed thread; a change it causes has no list to leave.
            onKeepRow={() => undefined}
            // The person chose this thread, so opening it reads it, as the Work list does.
            markRead
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
