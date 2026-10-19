import { ClipboardCheck } from 'lucide-react'
import type { ReviewWaitItem } from '../../../shared/artifact-review-waits'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorkNeedsYouCount } from '@/components/sidebar/WorkNeedsYouBadge'
import { useReviewWaits } from '@/components/work/use-review-waits'
import { openWorkDecisions } from '@/lib/open-work-decisions'
import { useAppStore } from '../store'

/** Pages still asking for a decision; '' is a page only this computer knows, still undecided. */
export function countUndecidedReviewWaits(
  items: readonly Pick<ReviewWaitItem, 'status'>[]
): number {
  return items.filter((item) => item.status === 'pending' || item.status === '').length
}

function DecisionsTitlebarBadgeCount(): React.JSX.Element | null {
  const needsYou = useWorkNeedsYouCount()
  const { items } = useReviewWaits()
  const pages = countUndecidedReviewWaits(items)
  const total = needsYou + pages
  if (total <= 0) {
    return null
  }
  const label = translate('decisionsTitlebar.label', 'Decisions waiting: {{count}}', {
    count: total
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="titlebar-icon-button"
          onClick={openWorkDecisions}
          aria-label={label}
          data-decisions-titlebar-badge={total}
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-agent-question/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-agent-question-text">
            <ClipboardCheck className="size-2.5" />
            {total}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate(
          'decisionsTitlebar.tooltip',
          'Pages waiting for a decision: {{pages}} · Need you: {{needsYou}}. Click to open Decisions.',
          { pages, needsYou }
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/** Read-only: counts what is already read and opens Decisions; it never answers anything. */
export function DecisionsTitlebarBadge(): React.JSX.Element | null {
  const enabled = useAppStore(
    (state) => state.settings?.experimentalDecisionsTitlebarBadge === true
  )
  // Why: mount the counting hooks only when on, so the review-waits poll stays off by default.
  return enabled ? <DecisionsTitlebarBadgeCount /> : null
}
