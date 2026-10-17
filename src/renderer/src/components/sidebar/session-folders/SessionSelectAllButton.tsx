import { CheckCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function SessionSelectAllButton({
  count,
  allSelected,
  onToggle
}: {
  count: number
  allSelected: boolean
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="w-full justify-start gap-1.5"
      disabled={count === 0}
      aria-pressed={allSelected}
      onClick={onToggle}
    >
      <CheckCheck className="size-3.5" />
      {allSelected
        ? translate('conversations.clearSelection', 'Clear selection')
        : translate('menu.selectAll', 'Select All')}
      <span className="ml-auto tabular-nums text-muted-foreground">{count}</span>
    </Button>
  )
}
