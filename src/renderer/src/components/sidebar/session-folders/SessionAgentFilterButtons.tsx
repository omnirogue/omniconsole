import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { SESSION_AGENT_FILTER_IDS } from '@/lib/session-agent-filter'
import { useSessionAgentFilter } from '@/store/session-agent-filter'

/** One logo per agent; the pressed one narrows the list to that agent's unarchived conversations. */
export function SessionAgentFilterButtons(): React.JSX.Element {
  const filter = useSessionAgentFilter((state) => state.filter)
  const toggle = useSessionAgentFilter((state) => state.toggle)
  // Why: no role=group — the sidebar treats every group as a folder group.
  return (
    <div className="flex items-center gap-0.5">
      {SESSION_AGENT_FILTER_IDS.map((agent) => {
        const pressed = filter === agent
        const name = getAgentLabel(agent)
        const label = pressed
          ? translate(
              'conversations.agentFilterClear',
              'Showing {{agent}} conversations — show all',
              {
                agent: name
              }
            )
          : translate('conversations.agentFilter', 'Show only {{agent}} conversations', {
              agent: name
            })
        return (
          <Tooltip key={agent}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={pressed ? 'secondary' : 'ghost'}
                size="icon-xs"
                className={pressed ? undefined : 'text-muted-foreground'}
                aria-label={label}
                aria-pressed={pressed}
                onClick={() => toggle(agent)}
              >
                <AgentIcon agent={agent} size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
