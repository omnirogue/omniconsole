import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SessionWorkerSummary } from '@/lib/session-sidebar-group-model'
import { cn } from '@/lib/utils'

/**
 * The count of the sessions this one dispatched as workers ("3 agents, 1 running"); a click lists
 * them under the row. Visible at rest, so folded workers are never out of reach.
 */
export function SessionRowWorkersToggle({
  name,
  workers,
  onToggle
}: {
  name: string
  workers: SessionWorkerSummary
  onToggle: () => void
}): React.JSX.Element {
  const summary =
    workers.running > 0
      ? translate('conversations.agentWorkersRunning', '{{count}} agents, {{running}} running', {
          count: workers.count,
          running: workers.running
        })
      : translate('conversations.agentWorkers', '{{count}} agents', { count: workers.count })
  const label = workers.expanded
    ? translate('conversations.hideAgentWorkers', 'Hide the agents {{name}} launched', { name })
    : translate('conversations.showAgentWorkers', 'Show the agents {{name}} launched', { name })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn(
            'shrink-0 gap-0.5 px-1 text-[11px] tabular-nums text-muted-foreground',
            workers.running > 0 && 'text-foreground'
          )}
          aria-label={`${label} (${summary})`}
          aria-expanded={workers.expanded}
          data-session-row-workers=""
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
        >
          <Bot className="size-3" aria-hidden />
          {workers.count}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{summary}</TooltipContent>
    </Tooltip>
  )
}
