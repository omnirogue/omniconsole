import { useState } from 'react'
import { ArrowRight, ChevronDown, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { MenuItem, moveMenuFocus } from '../next-step/NextStepAddAgentMenu'
import { useHoverOpenPopover } from '../next-step/use-hover-open-popover'
import {
  upNextIntentTemplates,
  type UpNextAgentIntent
} from '../../../../shared/up-next-agent-intent'
import type { UpNextAgentTemplate } from '../../../../shared/up-next-types'
import { intentLabel, templateLabel, templateSubtitle } from './up-next-labels'

/**
 * + Agent Review and + Agent Handoff: one button per intent, each opening its own one-click
 * menu of stage templates. The two menus never share an item (`up-next-agent-intent.ts`): a
 * reviewer inspects the work and reports; a handoff gives the work to the next agent to act on.
 * It opens on hover like the other Next-actions popovers, with menu roles for the keyboard.
 */
export function AgentIntentMenu({
  intent,
  disabled,
  title,
  onPick
}: {
  intent: UpNextAgentIntent
  disabled: boolean
  title?: string
  onPick: (template: UpNextAgentTemplate) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  const label = intentLabel(intent)
  const Icon = intent === 'review' ? Eye : ArrowRight
  return (
    <Popover open={open && !disabled} onOpenChange={hover.onOpenChange}>
      <PopoverAnchor asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn(
            'rounded-lg font-semibold',
            intent === 'review' ? 'border-ai-action-accent/60' : 'border-status-info/60'
          )}
          disabled={disabled}
          title={title}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          data-up-next-add-intent={intent}
          {...hover.anchorProps}
        >
          {`+ ${label}`}
          <Icon aria-hidden className="size-3.5" />
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-72 p-1"
        role="menu"
        aria-label={label}
        data-up-next-intent-menu={intent}
        onKeyDown={moveMenuFocus}
        {...hover.contentProps}
      >
        {upNextIntentTemplates(intent).map((template) => (
          <MenuItem
            key={template}
            title={templateLabel(template)}
            hint={templateSubtitle(template)}
            onSelect={() => {
              hover.onOpenChange(false)
              onPick(template)
            }}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}
