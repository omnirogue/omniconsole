import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { templateLabel } from './NextStepTemplateMenu'
import {
  NEXT_STEP_OUTCOME_TEMPLATE_IDS,
  type NextStepOutcomeTemplateId
} from './next-step-outcome-templates'
import { useHoverOpenPopover } from './use-hover-open-popover'

/** Arrow keys walk the enabled items, as a menu does; Home and End jump to the ends. */
export function moveMenuFocus(event: KeyboardEvent<HTMLDivElement>): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (item) => !item.hasAttribute('disabled')
  )
  if (!items.length) {
    return
  }
  const current = items.indexOf(document.activeElement as HTMLElement)
  const target =
    event.key === 'ArrowDown'
      ? items[(current + 1) % items.length]
      : event.key === 'ArrowUp'
        ? items[(current - 1 + items.length) % items.length]
        : event.key === 'Home'
          ? items[0]
          : event.key === 'End'
            ? items.at(-1)
            : undefined
  if (target) {
    event.preventDefault()
    target.focus()
  }
}

export function MenuItem({
  title,
  hint,
  disabled = false,
  onSelect
}: {
  title: ReactNode
  hint?: ReactNode
  disabled?: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      role="menuitem"
      className="h-auto w-full justify-start px-2 py-1.5 text-left font-normal"
      disabled={disabled}
      aria-disabled={disabled ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="min-w-0">
        <span className="block text-xs">{title}</span>
        {hint ? <span className="block text-[11px] text-muted-foreground">{hint}</span> : null}
      </span>
    </Button>
  )
}

/**
 * The one way agents join the plan: several reviewers at once, one worker, or a known shape.
 * It opens on hover like ＋ and every item is one click; a Radix menu cannot hover-open, so
 * this is a popover with menu roles.
 */
export function NextStepAddAgentMenu({
  agentDisabledReason,
  templateDisabled,
  onReview,
  onAgent,
  onTemplate
}: {
  agentDisabledReason: string | null
  templateDisabled: (id: NextStepOutcomeTemplateId) => boolean
  onReview: () => void
  onAgent: () => void
  onTemplate: (id: NextStepOutcomeTemplateId) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  const pick = (action: () => void) => (): void => {
    action()
    hover.onOpenChange(false)
  }
  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverAnchor asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-haspopup="menu"
          aria-expanded={open}
          data-next-step-add-agent
          {...hover.anchorProps}
        >
          <Plus className="size-3.5" />
          {translate('nextStep.addAgent', 'Add agent')}
          <ChevronDown className="size-3" />
        </Button>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        className="w-64 p-1"
        role="menu"
        aria-label={translate('nextStep.addAgent', 'Add agent')}
        onKeyDown={moveMenuFocus}
        {...hover.contentProps}
      >
        <MenuItem
          title={translate('nextStep.addReview', 'Review')}
          hint={translate('nextStep.addReviewHint', 'several agents at once')}
          onSelect={pick(onReview)}
        />
        <MenuItem
          title={translate('nextStep.addOneAgent', 'Agent')}
          hint={
            agentDisabledReason ?? translate('nextStep.addOneAgentHint', 'one agent does the work')
          }
          disabled={Boolean(agentDisabledReason)}
          onSelect={pick(onAgent)}
        />
        <div role="separator" className="my-1 h-px bg-border" />
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          {translate('nextStep.templates', 'Templates')}
        </p>
        {NEXT_STEP_OUTCOME_TEMPLATE_IDS.map((id) => (
          <MenuItem
            key={id}
            title={templateLabel(id)}
            disabled={templateDisabled(id)}
            onSelect={pick(() => onTemplate(id))}
          />
        ))}
      </PopoverContent>
    </Popover>
  )
}
