import { Archive, ArchiveRestore } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** The row's 🗄 quick action; Unarchive only when the person archived the row by hand. */
export function ConversationArchiveButton({
  archivedByHand,
  name,
  disabledReason = null,
  onClick
}: {
  archivedByHand: boolean
  name: string
  /** Why the action is off for this row (a ledger-only row's "Open it on <Computer>."). */
  disabledReason?: string | null
  onClick: () => void
}): React.JSX.Element {
  const label = archivedByHand
    ? translate('conversations.unarchiveItem', 'Unarchive {{name}}', { name })
    : translate('conversations.archiveItem', 'Archive {{name}}', { name })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          onClick={onClick}
        >
          {archivedByHand ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{disabledReason ?? label}</TooltipContent>
    </Tooltip>
  )
}
