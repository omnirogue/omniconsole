import { Clock3 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { routineRowStateLabel, type RoutineRowState } from './routine-row-details'

/**
 * The routine's state glyph, explained on hover like a conversation's state icon. `sm` is the
 * 12 px glyph of a one-line row; `md` the 16 px one of a comfortable row.
 */
export function RoutineStateIcon({
  state,
  size = 'md'
}: {
  state: RoutineRowState
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const label = routineRowStateLabel(state)
  const box = size === 'sm' ? 'size-3' : 'size-4'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          data-routine-state={state === 'idle' ? 'active' : state}
          data-routine-state-size={size}
          className={cn('inline-flex shrink-0 items-center justify-center', box)}
        >
          {/* Why: every routine reads as a clock among the conversations; a paused one is dimmed. */}
          <Clock3
            className={cn(
              box,
              state === 'due'
                ? 'text-status-warning'
                : state === 'paused'
                  ? 'text-muted-foreground/40'
                  : 'text-muted-foreground'
            )}
            aria-hidden="true"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
