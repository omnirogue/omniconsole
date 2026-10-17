import { ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** Switches the Conversations list between its status groups and one group per task. */
export function SessionGroupByTaskToggle({
  pressed,
  onPressedChange
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
}): React.JSX.Element {
  const label = translate('conversations.groupByTask', 'Group by task')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={pressed ? 'secondary' : 'ghost'}
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={label}
          aria-pressed={pressed}
          onClick={() => onPressedChange(!pressed)}
        >
          <ListChecks className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
