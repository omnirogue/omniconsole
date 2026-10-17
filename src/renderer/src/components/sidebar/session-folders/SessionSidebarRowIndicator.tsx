import { AlarmClock, Bell, Hourglass, Lock } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { ConversationState } from '@/lib/conversation-state'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import { cn } from '@/lib/utils'
import type { SessionRowStatusInput } from './session-row-status'
import { ROW_REST_MARK } from './session-row-reveal'

export type SessionRowIndicatorKind = 'needs-you' | 'running' | 'snoozed' | 'locked' | 'waiting'

const LIVE_CHAIN = new Set(['waiting', 'ready', 'launching'])

/**
 * The one mark a one-line row shows at rest, by what matters most: a row waiting on the person,
 * then one that is working, then one put away until later, then one a plan holds.
 */
export function sessionRowIndicator(input: {
  needsYou: boolean
  visualState: ConversationState
  waitingUntil: string | null
  locked: SessionRowStatusInput['locked']
  chain: SessionChainRowInfo | null
  launchedBy: SessionChainRowInfo | null
}): SessionRowIndicatorKind | null {
  if (input.visualState === 'running' || input.visualState === 'working') {
    return 'running'
  }
  if (input.visualState === 'done') {
    return null
  }
  if (input.needsYou) {
    return 'needs-you'
  }
  if (['awaiting', 'recovering', 'queued', 'plan-ready'].includes(input.visualState)) {
    return 'waiting'
  }
  if (input.waitingUntil !== null) {
    return 'snoozed'
  }
  if (
    input.locked !== null ||
    input.launchedBy !== null ||
    (input.chain !== null && LIVE_CHAIN.has(input.chain.state))
  ) {
    return 'locked'
  }
  return null
}

function indicatorLabel(kind: SessionRowIndicatorKind): string {
  switch (kind) {
    case 'waiting':
      return translate('conversations.indicatorWaiting', 'Waiting')
    case 'needs-you':
      return translate('conversations.indicatorNeedsYou', 'Needs you')
    case 'running':
      return translate('workPlan.running', 'Running')
    case 'snoozed':
      return translate('conversations.indicatorSnoozed', 'Snoozed')
    case 'locked':
      return translate('conversations.indicatorLocked', 'Next step is set')
  }
}

/**
 * The compact row's resting mark. It takes the actions' place: hovering or focusing the row hides
 * it as the folded actions open, so the name only gives up width while the buttons are showing.
 */
export function SessionSidebarRowIndicator({
  kind
}: {
  kind: SessionRowIndicatorKind
}): React.JSX.Element {
  const label = indicatorLabel(kind)
  return (
    <span
      className={cn('pointer-events-none flex items-center px-1.5', ROW_REST_MARK)}
      role="img"
      aria-label={label}
      title={label}
      data-session-row-indicator={kind}
    >
      {kind === 'needs-you' ? (
        <Bell className="size-3 text-agent-question" aria-hidden="true" />
      ) : kind === 'waiting' ? (
        <Hourglass className="size-3 text-status-warning" aria-hidden="true" />
      ) : kind === 'running' ? (
        <span className="size-2 rounded-full bg-status-success motion-safe:animate-pulse" />
      ) : kind === 'snoozed' ? (
        <AlarmClock className="size-3 text-muted-foreground" aria-hidden="true" />
      ) : (
        <Lock className="size-3 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  )
}
