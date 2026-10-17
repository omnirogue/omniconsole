import {
  Bell,
  CircleCheck,
  CircleX,
  Hourglass,
  MessageSquare,
  SquareTerminal,
  CircleDashed,
  Circle,
  RotateCw
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { conversationStateLabel, type ConversationState } from '@/lib/conversation-state'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

const ICONS = {
  'needs-you': Bell,
  running: Circle,
  working: Circle,
  queued: CircleDashed,
  recovering: RotateCw,
  awaiting: Hourglass,
  'plan-ready': CircleCheck,
  active: Circle,
  inactive: Circle,
  unverifiable: CircleDashed,
  interrupted: CircleX,
  done: CircleCheck,
  failed: CircleX,
  waiting: Hourglass,
  none: MessageSquare
} satisfies Record<ConversationState, typeof Circle>

const COLORS = {
  'needs-you': 'text-agent-question',
  running: 'fill-current text-status-success motion-safe:animate-pulse',
  working: 'fill-current text-status-success motion-safe:animate-pulse',
  queued: 'text-status-warning',
  // Why muted: the host is handling these by itself; only a request may pull the eye.
  recovering: 'text-status-warning',
  awaiting: 'text-status-warning',
  'plan-ready': 'text-status-success',
  active: 'text-muted-foreground',
  inactive: 'fill-current text-muted-foreground',
  unverifiable: 'text-muted-foreground',
  interrupted: 'text-destructive',
  done: 'text-muted-foreground',
  failed: 'text-destructive',
  waiting: 'text-muted-foreground',
  none: 'text-muted-foreground'
} satisfies Record<ConversationState, string>

/**
 * Every state has an explicit glyph; color supplements its accessible label. `sm` is the
 * 12 px glyph of a one-line row, where the chat bubble of an idle row must not dominate.
 */
export function ConversationStateIcon({
  state,
  unreadCompletion = false,
  surface,
  className,
  label: labelOverride,
  size = 'md'
}: {
  unreadCompletion?: boolean
  surface?: 'chat' | 'terminal'
  state: ConversationState
  className?: string
  label?: string
  size?: 'sm' | 'md'
}): React.JSX.Element {
  const unread = unreadCompletion && state === 'done'
  const label =
    labelOverride ??
    (unread
      ? translate(
          'auto.components.tab.bar.TerminalTabLeadingIcon.7ab2964bea',
          'Unread agent completion'
        )
      : conversationStateLabel(state))
  const showSurface = surface && ['working', 'running', 'active', 'done', 'none'].includes(state)
  const Icon = unread
    ? Bell
    : showSurface
      ? surface === 'chat'
        ? MessageSquare
        : SquareTerminal
      : ICONS[state]
  const box = size === 'sm' ? 'size-3' : 'size-4'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn('inline-flex shrink-0 items-center justify-center', box)}
          role="img"
          aria-label={label}
          data-conversation-state={state}
          data-conversation-surface={surface}
          data-conversation-state-size={size}
        >
          {unread || state !== 'done' || surface ? (
            <Icon
              className={cn(
                box,
                unread
                  ? 'fill-current text-status-warning'
                  : showSurface
                    ? COLORS[state]
                        .replace('motion-safe:animate-spin ', '')
                        .replace('fill-current ', '')
                    : COLORS[state],
                className
              )}
              aria-hidden="true"
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
