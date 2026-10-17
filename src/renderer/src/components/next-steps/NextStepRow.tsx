import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  NextStepSuggestion,
  NextStepSuggestionOrigin
} from '../../../../shared/next-step-suggestions'
import { nextStepPromptVisibility } from './next-steps-prompt-disclosure'

/** One suggestion: its title, and behind a disclosure the exact prompt a Run sends. */
export function NextStepRow({
  suggestion,
  origin,
  checked,
  disabled,
  onCheckedChange,
  onRun
}: {
  suggestion: NextStepSuggestion
  origin: NextStepSuggestionOrigin
  checked: boolean
  disabled: boolean
  onCheckedChange: (checked: boolean) => void
  onRun: () => void
}) {
  const visibility = nextStepPromptVisibility(suggestion, origin)
  const [open, setOpen] = useState(visibility === 'open')
  const promptId = useId()
  const shown = visibility === 'always' || (visibility !== 'none' && open)
  const disclosable = visibility === 'open' || visibility === 'closed'
  return (
    <li className="py-1" data-next-step-row={suggestion.id}>
      <div className="flex items-start gap-2">
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          aria-label={suggestion.title}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
        <div className="min-w-0 flex-1 text-xs">
          <p className="break-words">{suggestion.title}</p>
          {suggestion.why ? (
            <p className="break-words text-muted-foreground">{suggestion.why}</p>
          ) : null}
        </div>
        {suggestion.risk === 'risky' ? (
          <Badge variant="outline" className="text-status-warning">
            {translate('nextSteps.risky', 'Needs a tick')}
          </Badge>
        ) : null}
        {disclosable ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-expanded={open}
            aria-controls={promptId}
            aria-label={translate('nextSteps.showPrompt', 'Show prompt: {{title}}', {
              title: suggestion.title
            })}
            onClick={() => setOpen((value) => !value)}
          >
            <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={disabled}
          aria-label={`${translate('nextSteps.runOne', 'Run')}: ${suggestion.title}`}
          onClick={onRun}
        >
          {translate('nextSteps.runOne', 'Run')}
        </Button>
      </div>
      {shown ? (
        <pre
          id={promptId}
          aria-label={translate('nextSteps.promptLabel', 'Prompt that will be sent')}
          data-next-step-prompt={visibility}
          className={cn(
            'ml-6 mt-1 whitespace-pre-wrap break-words rounded-sm border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground',
            // Why no height cap on an AI prompt: every word of it is what would be sent.
            visibility !== 'always' && 'max-h-40 overflow-y-auto scrollbar-sleek'
          )}
        >
          {suggestion.prompt}
        </pre>
      ) : null}
    </li>
  )
}
