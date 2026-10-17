import { conversationSourceForSession } from '@/lib/conversation-source-for-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { useNextStepKeepGoingRunning, usePendingNextStepCount } from './next-steps-pending-store'
import { KeepGoingDot } from './NextStepsTerminalPill'

/** "✦3" on a session row whose conversation has suggested next steps waiting; opens it. */
export function NextStepsSessionBadge({
  session,
  onOpen
}: {
  session: SidebarSession
  onOpen: () => void
}) {
  const conversation = conversationSourceForSession(session)
  const count = usePendingNextStepCount(conversation)
  const running = useNextStepKeepGoingRunning(conversation)
  if (!count && !running) {
    return null
  }
  return (
    <Badge
      asChild
      variant="outline"
      className="mr-1 cursor-pointer border-status-info-border bg-status-info-background px-1.5 py-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <button
        type="button"
        data-next-steps-badge={count}
        data-next-steps-keep-going={running || undefined}
        aria-label={[
          count
            ? translate('nextSteps.badgeLabel', '{{n}} suggested next steps in {{session}}', {
                n: count,
                session: session.label
              })
            : null,
          running
            ? translate('nextSteps.keepGoing.badgeLabel', 'Keep going is on in {{session}}', {
                session: session.label
              })
            : null
        ]
          .filter(Boolean)
          .join('. ')}
        onClick={(event) => {
          event.stopPropagation()
          onOpen()
        }}
      >
        <span className="inline-flex items-center gap-0.5">
          {running ? <KeepGoingDot /> : null}
          {count ? translate('nextSteps.badge', '✦{{n}}', { n: count }) : null}
        </span>
      </button>
    </Badge>
  )
}
