import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ROW_HOVER_REVEAL } from './session-row-reveal'

/**
 * The chevron that opens a row's details. It shows on hover or focus like the quick actions (and,
 * like them, takes no width until then), and stays put while the details are open so the row can
 * be folded back.
 */
export function SessionSidebarRowExpandToggle({
  name,
  expanded,
  detailsId,
  onToggle
}: {
  name: string
  expanded: boolean
  detailsId: string
  onToggle: () => void
}): React.JSX.Element {
  const label = expanded
    ? translate('conversations.hideDetails', 'Hide details for {{name}}', { name })
    : translate('conversations.showDetails', 'Show details for {{name}}', { name })
  return (
    <span className={expanded ? 'flex items-center' : ROW_HOVER_REVEAL}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground"
            aria-label={label}
            aria-expanded={expanded}
            aria-controls={detailsId}
            data-session-row-expand=""
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </span>
  )
}
