import { useMemo } from 'react'
import { Coins } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  estimatePromptCost,
  promptCostEstimatorText,
  type PromptCostEstimatorLabels
} from './prompt-cost-estimator-helpers'

export type PromptCostEstimatorBadgeProps = {
  prompt: string
  /** The selected model's current input rate; omitted pricing stays unknown. */
  inputUsdPerMillion?: number | null
  modelLabel?: string
  labels?: Partial<PromptCostEstimatorLabels>
  locale?: string
  className?: string
}

export function PromptCostEstimatorBadge({
  prompt,
  inputUsdPerMillion,
  modelLabel,
  labels,
  locale,
  className
}: PromptCostEstimatorBadgeProps): React.JSX.Element | null {
  const estimate = useMemo(
    () => estimatePromptCost(prompt, inputUsdPerMillion),
    [prompt, inputUsdPerMillion]
  )
  if (estimate.inputTokens === 0) {
    return null
  }
  const text = promptCostEstimatorText(estimate, labels, locale, modelLabel)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          tabIndex={0}
          className={cn('text-muted-foreground tabular-nums', className)}
          aria-label={text.accessible}
          data-prompt-cost-state={estimate.inputCostUsd === null ? 'unavailable' : 'estimated'}
        >
          <Coins aria-hidden="true" />
          {text.summary}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 space-y-1 text-left">
        {text.model && <p className="font-medium">{text.model}</p>}
        <p>{text.tokens}</p>
        <p>{text.description}</p>
      </TooltipContent>
    </Tooltip>
  )
}
