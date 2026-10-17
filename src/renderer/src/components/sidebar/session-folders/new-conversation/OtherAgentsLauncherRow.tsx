import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import {
  isOtherLauncherAgent,
  type LaunchPick,
  type LauncherCapability
} from './resolve-launch-plan'

/** Installed agent CLIs outside the provider rows; they start in this launcher's target like any other. */
export function OtherAgentsLauncherRow({
  capabilities,
  hover,
  start,
  disabled
}: {
  capabilities: LauncherCapability[]
  hover: HoverOpenContentProps
  start: (pick: LaunchPick) => void
  disabled?: boolean
}): React.JSX.Element | null {
  const agents = capabilities
    .filter((entry) => entry.status === 'usable' && isOtherLauncherAgent(entry.id))
    .sort((a, b) => a.label.localeCompare(b.label))
  if (!agents.length) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={disabled}>
        {translate('conversationLauncher.otherAgents', 'Other agents')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        onPointerMove={hover.onPointerMove}
        onPointerEnter={hover.onPointerEnter}
        onPointerLeave={hover.onPointerLeave}
        onPointerDownCapture={hover.onPointerDownCapture}
      >
        {agents.map((entry) => (
          <DropdownMenuItem key={entry.id} onSelect={() => start({ otherAgent: entry.id })}>
            <AgentIcon agent={entry.id} size={16} />
            {entry.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
