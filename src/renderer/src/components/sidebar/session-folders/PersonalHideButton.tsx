import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

export function PersonalHideButton({
  hidden,
  name,
  onClick
}: {
  hidden: boolean
  name: string
  onClick: () => void
}): React.JSX.Element {
  const label = hidden
    ? translate('conversations.unhideItem', 'Show {{name}}', { name })
    : translate('conversations.hideItem', 'Hide {{name}}', { name })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          {hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
