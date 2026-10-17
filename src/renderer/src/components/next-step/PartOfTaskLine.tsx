import { ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useWorkFolders, useWorkFoldersScope } from '@/components/companies/use-work-folders'
import { useBackofficeWorkFocus } from '@/components/task-page/backoffice/backoffice-work-selection'
import { taskCardCompanyPlace } from '@/lib/task-card-company-place'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'

/**
 * "Part of: <task> · <company › domain> · due <date>" — the larger outcome a bound pane
 * serves, read from the same linked card `CreateTaskButton` already tracks. Hidden while
 * unbound; a click asks the Work list to open the card, the same request Attention and
 * deep links already make.
 */
export function PartOfTaskLine({
  card
}: {
  card: BackofficeTodoItem | null
}): React.JSX.Element | null {
  const scope = useHandoffScope()
  const folders = useWorkFolders(useWorkFoldersScope())
  const openTaskPage = useAppStore((state) => state.openTaskPage)
  if (!card) {
    return null
  }
  const place = taskCardCompanyPlace(
    folders.data?.companies ?? [],
    card.company_slug,
    card.org_unit_id
  )
  const due = card.due_date
    ? translate('nextStep.partOfDue', 'due {{date}}', { date: card.due_date })
    : null
  const details = [place, due].filter((part): part is string => Boolean(part)).join(' · ')
  const line = details
    ? translate('nextStep.partOfTaskWithDetails', 'Part of: {{title}} · {{details}}', {
        title: card.title,
        details
      })
    : translate('nextStep.partOfTask', 'Part of: {{title}}', { title: card.title })
  return (
    <button
      type="button"
      data-part-of-task={card.task_id}
      className="flex min-w-0 items-center gap-1 truncate px-3 pb-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground hover:underline"
      onClick={() => {
        useBackofficeWorkFocus.getState().focus({ scope, taskId: card.task_id })
        openTaskPage({ taskSource: 'backoffice' })
      }}
    >
      <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden />
      <span className="truncate">{line}</span>
    </button>
  )
}
