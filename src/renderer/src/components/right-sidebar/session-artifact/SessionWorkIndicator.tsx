import { ScrollText } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { requestSessionPanelView } from './session-panel-view-request'
import { useSessionWorkView } from './session-work-view-store'

/**
 * The only hint a collapsed right panel gives: the on-screen session has a plan or an omnios page.
 * It never opens anything by itself; a click opens Session work on that plan or page.
 */
export function SessionWorkIndicator(): React.JSX.Element | null {
  const pages = useSessionWorkView((s) => s.pages)
  const plans = useSessionWorkView((s) => s.plans)
  if (pages === 0 && plans === 0) {
    return null
  }
  // Why the tab names: the indicator, its tooltip and the tabs it opens say the same words.
  const label =
    pages > 0 && plans > 0
      ? translate('sessionPanel.indicatorBoth', 'Plan · OmniOS')
      : plans > 0
        ? translate('sessionPanel.indicatorPlan', 'Plan')
        : translate('sessionPanel.indicatorPage', 'OmniOS')
  const hint = translate('sessionPanel.indicatorHint', 'Open this session’s work: {{views}}', {
    views: label
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="mr-1 flex h-6 max-w-[120px] items-center gap-1 rounded-full border border-status-info-border px-2 text-[11px] text-foreground hover:bg-accent"
          data-session-work-indicator=""
          aria-label={hint}
          onClick={() => requestSessionPanelView(plans > 0 && pages === 0 ? 'plan' : 'omnios')}
        >
          <ScrollText className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}
