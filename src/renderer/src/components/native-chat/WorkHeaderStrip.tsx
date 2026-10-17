import { CircleCheck, Info } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { cn } from '@/lib/utils'
import type { WorkHeaderSummary } from './work-header-summary'
import type { ConversationInformationSection } from './ConversationInformation'

/** Both disclosures share one look: a small icon button with its name as tooltip and label. */
function InformationIconButton({
  ref,
  label,
  open,
  controls,
  section,
  onClick,
  children
}: {
  ref: Ref<HTMLButtonElement>
  label: string
  open: boolean
  controls: string
  section: ConversationInformationSection
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
          aria-label={label}
          aria-expanded={open}
          aria-controls={controls}
          data-state={open ? 'open' : 'closed'}
          data-conversation-information-toggle={section}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Conversation identity stays visible; the two icon disclosures reuse its existing surfaces. */
export function WorkHeaderStrip({
  session,
  collapsed,
  panelId,
  summary,
  onToggle,
  chevronRef,
  trailing,
  section,
  onSectionToggle,
  detailsId,
  detailsRef,
  showOutcome
}: {
  session: SidebarSession
  collapsed: boolean
  panelId: string
  summary: WorkHeaderSummary
  onToggle: () => void
  chevronRef: Ref<HTMLButtonElement>
  trailing?: ReactNode
  section: ConversationInformationSection | null
  onSectionToggle: (section: ConversationInformationSection) => void
  detailsId: string
  detailsRef: Ref<HTMLButtonElement>
  showOutcome: boolean
}): React.JSX.Element {
  return (
    <>
      <div
        className="group flex h-9 min-w-0 items-center gap-2 px-3"
        data-conversation-header-row=""
        data-work-header-toggle=""
        style={{ paddingRight: 'calc(var(--pane-header-action-gutter, 0px) + var(--spacing) * 3)' }}
        data-work-header-state={collapsed ? 'collapsed' : 'expanded'}
      >
        <button
          type="button"
          tabIndex={showOutcome ? -1 : undefined}
          disabled={!showOutcome}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 text-left disabled:cursor-default"
          data-work-header-row=""
          onClick={onToggle}
        >
          <span
            className={cn(
              'min-w-0 truncate text-xs font-medium',
              collapsed && showOutcome && 'max-w-[50%]'
            )}
            data-work-header-label=""
            title={session.label}
          >
            {session.label}
          </span>
          {collapsed && showOutcome && (
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-xs',
                summary.kind === 'needs-you'
                  ? 'font-medium text-agent-question-text'
                  : 'text-muted-foreground'
              )}
              data-work-header-summary={summary.kind}
              title={summary.text}
            >
              {summary.text}
            </span>
          )}
        </button>
        {trailing && <div className="shrink-0">{trailing}</div>}
      </div>
      <div
        className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-1.5"
        data-conversation-information-controls
      >
        <InformationIconButton
          ref={detailsRef}
          label={translate('nextAction.sessionDetails', 'Session details')}
          open={section === 'details'}
          controls={detailsId}
          section="details"
          onClick={() => onSectionToggle('details')}
        >
          <Info className="size-3.5" aria-hidden />
        </InformationIconButton>

        <InformationIconButton
          ref={chevronRef}
          label={translate('sessionContext.contextAndOutcome', 'Session context & outcome')}
          open={!collapsed}
          controls={panelId}
          section="outcome"
          onClick={onToggle}
        >
          <CircleCheck className="size-3.5" aria-hidden />
        </InformationIconButton>
      </div>
    </>
  )
}
