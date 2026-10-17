import { Clock3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SessionRowStatus } from './session-row-status'

/**
 * The one line under a row's name. In the list it always clips on one line: the full reason
 * lives in the row's details block, never wrapped into the list. Inside the hover card it wraps.
 */
export function SessionSidebarRowStatusLine({
  status,
  wrap = false
}: {
  status: SessionRowStatus
  wrap?: boolean
}): React.JSX.Element {
  // Why: the asking colour is for a question only. A failure is an honest failure in its own
  // style, and what the host handles by itself stays as quiet as any other caption.
  const asks = status.kind === 'ask' || status.kind === 'returned'
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 text-xs',
        asks
          ? 'font-medium text-agent-question-text'
          : status.kind === 'failed'
            ? 'font-normal text-destructive'
            : 'font-normal text-muted-foreground'
      )}
      title={status.kind === 'ask' ? status.why : undefined}
      data-session-status={status.kind}
      data-session-plan-blocked={
        status.kind === 'ask' ? (status.blockedReason ?? undefined) : undefined
      }
      data-session-returned={status.kind === 'returned' ? '' : undefined}
      data-session-waiting-until={status.kind === 'snoozed' ? status.until : undefined}
      data-session-completed={status.kind === 'caption' ? status.reason : undefined}
      data-session-locked={status.kind === 'locked' ? '' : undefined}
    >
      {status.kind === 'queue' ? <Clock3 className="size-3 shrink-0" /> : null}
      <span className={cn('min-w-0 flex-1', wrap ? 'whitespace-normal' : 'truncate')}>
        {status.text}
      </span>
    </span>
  )
}
