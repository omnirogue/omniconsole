import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import type { UpNextAttention, UpNextHeader } from '../../../../shared/up-next-types'
import { FinishedSessionDispositionRetry } from './FinishedSessionDispositionRetry'
import { UpNextDiagnostic } from './up-next-diagnostic'
import { clockLabel } from './up-next-labels'
import { stoppedHeaderLine } from './up-next-run-labels'

type Tone = 'warning' | 'success' | 'info' | 'muted' | 'destructive'

/**
 * The mockup's state dot: a filled point with a soft ring in the state's own colour. The ring
 * uses the 25% `-border` tokens; the 10% `-background` ones are invisible at 3px.
 */
function StateDot({ tone }: { tone: Tone }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full ring-[3px]',
        tone === 'warning' && 'bg-status-warning ring-status-warning-border',
        tone === 'success' && 'bg-status-success ring-status-success-border',
        tone === 'info' && 'bg-status-info ring-status-info-border',
        tone === 'muted' && 'bg-muted-foreground ring-border',
        tone === 'destructive' && 'bg-destructive ring-destructive/25'
      )}
    />
  )
}

/** "✓ Completed 14:31", then what became of the session — only ever what a window reported. */
function finishedLine(header: UpNextHeader): string {
  if (header.state === 'closed') {
    return t('upNext.finishedHeader', '✓ Done · closed {{time}}', {
      time: header.closedAt === undefined ? '' : clockLabel(header.closedAt)
    }).trimEnd()
  }
  const completed =
    header.completedAt === undefined
      ? t('upNext.completedHeader', '✓ Completed')
      : t('upNext.completedHeaderAt', '✓ Completed {{time}}', {
          time: clockLabel(header.completedAt)
        })
  const disposition = header.disposition
  if (!disposition) {
    return completed
  }
  const save = disposition.intent === 'save'
  // Why a failed close or save adds nothing here: the run reads Completed, and what did not
  // happen to its session is said quietly on the line below, with the way to try again.
  const note =
    disposition.state === 'applied'
      ? save
        ? t('upNext.dispositionSaved', 'saved')
        : ''
      : disposition.state === 'pending'
        ? save
          ? t('upNext.dispositionSaving', 'saving the session…')
          : t('upNext.dispositionClosing', 'closing the session…')
        : ''
  return [completed, note].filter(Boolean).join(' · ')
}

function AttentionRequest({
  request,
  onAction
}: {
  request: UpNextAttention
  onAction?: (request: UpNextAttention) => void
}): React.JSX.Element {
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
      data-up-next-attention={request.id}
      title={request.why}
    >
      <StateDot tone="warning" />
      <span className="min-w-0 flex-1 break-words font-medium text-status-warning">
        {t('upNext.needsYou', 'Needs you: {{ask}}', { ask: request.ask })}
      </span>
      {request.action && onAction && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          data-up-next-attention-action={request.action.kind}
          onClick={() => onAction(request)}
        >
          {request.action.label}
        </Button>
      )}
    </li>
  )
}

/**
 * The one line that states the run's state under the Up next header, and the only place it is
 * said. It reads the header the host projected from the ONE policy: "Needs you" appears only with
 * an open request and says what is asked, with the direct way to meet it; a recovering, waiting
 * or failed run says so in plain words, and the host's raw diagnostic stays under Details.
 */
export function UpNextHeaderStatus({
  header,
  onAction,
  onRetryDisposition,
  now
}: {
  header: UpNextHeader
  onAction?: (request: UpNextAttention) => void
  /** Asks the host to try a close or save again after its own retries ran out. */
  onRetryDisposition?: () => Promise<void>
  /** The clock "next attempt in …" is read against; injectable so a test is deterministic. */
  now?: number
}): React.JSX.Element | null {
  // Only a recovering run prints a countdown, so only it holds the shared tick open.
  const ticking = useNow(10_000, header.state === 'recovering' && now === undefined)
  const clock = now ?? ticking
  if (header.state === 'closed' || header.state === 'completed') {
    const disposition = header.disposition
    return (
      <div className="min-w-0 space-y-1 text-xs" data-up-next-header-status={header.state}>
        <p className="flex min-w-0 items-center gap-1.5">
          <StateDot tone="success" />
          <span className="min-w-0 break-words">{finishedLine(header)}</span>
        </p>
        {disposition?.state === 'failed' && (
          <FinishedSessionDispositionRetry
            scope="header"
            disposition={{
              intent: disposition.intent,
              ...(disposition.error ? { error: disposition.error } : {})
            }}
            onRetry={onRetryDisposition}
          />
        )}
      </div>
    )
  }
  if (header.state === 'needs-you') {
    return (
      <div role="status" className="min-w-0 text-xs" data-up-next-header-status="needs-you">
        <ul className="min-w-0 space-y-1">
          {(header.attention ?? []).map((request) => (
            <AttentionRequest key={request.id} request={request} onAction={onAction} />
          ))}
        </ul>
      </div>
    )
  }
  if (header.state === 'running' || header.state === 'idle') {
    return null
  }
  const failed = header.state === 'failed'
  return (
    <div className="min-w-0 space-y-1 text-xs" data-up-next-header-status={header.state}>
      <p
        role="status"
        className={cn(
          'flex min-w-0 items-center gap-1.5 font-medium',
          failed ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        <StateDot
          tone={failed ? 'destructive' : header.state === 'recovering' ? 'info' : 'muted'}
        />
        <span className="min-w-0 break-words">{stoppedHeaderLine(header, clock)}</span>
      </p>
      {failed && (
        <UpNextDiagnostic
          scope="header"
          text={header.failure?.reason}
          code={header.failure?.code}
        />
      )}
    </div>
  )
}
