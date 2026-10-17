import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  upNextIsStoppedStage,
  type UpNextAgentBlock,
  type UpNextNow,
  type UpNextView
} from '../../../../shared/up-next-types'
import type { UpNextController } from './use-up-next'
import { UpNextDiagnostic } from './up-next-diagnostic'
import { clockLabel, durationLabel, stateLabel } from './up-next-labels'
import { RailBadge } from './up-next-rail'
import { stoppedStageLine } from './up-next-run-labels'

/**
 * The read-only facts of a stage that has started (amendment 1). A stopped stage leads with what
 * CLASS of stop it is, in plain words; the host's raw reason is a diagnostic and sits folded under
 * Details, never as the line the person reads first. The verdict summary follows: the row
 * truncates it, so its full text is a wrapped paragraph here.
 */
export function StageFacts({
  block,
  controller
}: {
  block: UpNextAgentBlock
  controller: UpNextController
}) {
  const stopped = upNextIsStoppedStage(block)
  return (
    <div className="space-y-2">
      {stopped && (
        <div className="min-w-0 space-y-1" data-up-next-stop={block.state}>
          <p
            className={cn(
              'min-w-0 break-words font-medium',
              block.state === 'failed' && 'text-destructive',
              block.state === 'needs-you' && 'text-status-warning',
              (block.state === 'recovering' || block.state === 'waiting') && 'text-muted-foreground'
            )}
          >
            {stoppedStageLine(block.state, block.progress?.stopCode)}
          </p>
          <UpNextDiagnostic
            scope="stage"
            text={block.progress?.blockedReason}
            code={block.progress?.stopCode}
          />
        </div>
      )}
      {block.progress?.verdictSummary && (
        <p
          className="min-w-0 whitespace-pre-wrap break-words text-muted-foreground"
          data-up-next-verdict-summary
        >
          {block.progress.verdictSummary}
        </p>
      )}
      <p className="text-muted-foreground">
        {t('upNext.stageShape', '{{count}} agents · {{shape}}', {
          count: block.n,
          shape: block.shape
        })}
        {block.progress?.startedAt !== undefined &&
          ` · ${t('upNext.started', 'started {{time}}', {
            time: clockLabel(block.progress.startedAt)
          })}`}
      </p>
      {block.progress?.seats?.length ? (
        <ul className="space-y-0.5 text-muted-foreground">
          {block.progress.seats.map((seat) => (
            <li key={seat.id} className="min-w-0 break-words">
              {seat.id} ·{' '}
              {seat.state === 'failed' ? t('upNext.failed', 'failed') : stateLabel(seat.state)}
              {seat.verdict ? ` · ${seat.verdict}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {block.progress?.receiptRef && (
        <p className="min-w-0 truncate text-muted-foreground" title={block.progress.receiptRef}>
          {t('upNext.receipt', 'Receipt')}: {block.progress.receiptRef}
        </p>
      )}
      {(block.state === 'running' || stopped) && (
        <Button
          size="xs"
          variant="outline"
          disabled={controller.disabled}
          onClick={() => void controller.configureAfter(block.id)}
        >
          {t('upNext.configureAfter', 'Configure a stage after this')}
        </Button>
      )}
    </div>
  )
}

/**
 * "claude · 14 min" while working; "Claude Code · waiting for you" while idle. The idle agent
 * waits for the PERSON only when nothing else is pending: while the run is recovering, waiting on
 * someone else or failed, saying "waiting for you" would hand them a turn that is not theirs.
 */
function nowSummary(
  now: Extract<UpNextNow, { kind: 'current-work' | 'idle' }>,
  header: UpNextView['header']['state']
): string {
  const tail =
    now.kind === 'current-work'
      ? now.elapsedMs === undefined
        ? ''
        : durationLabel(now.elapsedMs)
      : header === 'idle' || header === 'needs-you'
        ? t('upNext.waitingForYou', 'waiting for you')
        : ''
  return [now.agent, tail].filter(Boolean).join(' · ')
}

/**
 * The pinned, read-only Now row when no stage is the current work: what the agent is doing and
 * for how long, or "idle · waiting for you". Same anatomy and rail geometry as every other row,
 * including the narrow-row stacking (`@max-[28rem]/row:`); the info stripe and the pulsing
 * badge are for working only — idle carries the plain border.
 *
 * `quiet` is the idle-and-empty track (brief 78 #2): the row takes the done strip's lighter
 * weight (no stripe, no glyph) so an idle agent never reads as heavily as a running stage.
 */
export function NowRow({ view, quiet = false }: { view: UpNextView; quiet?: boolean }) {
  const now = view.now
  if (now.kind === 'stage' || now.kind === 'closed' || now.kind === 'completed') {
    return null
  }
  const working = now.kind === 'current-work'
  const summary = nowSummary(now, view.header.state)
  return (
    <div
      data-up-next-now
      data-up-next-now-quiet={quiet ? '' : undefined}
      className={cn(
        '@container/row relative min-w-0 rounded-xl border',
        quiet
          ? 'border-transparent bg-muted/60 text-muted-foreground'
          : ['border-l-[3px] bg-muted/40', working ? 'border-l-status-info' : 'border-l-border']
      )}
    >
      <RailBadge tone={working ? 'now' : 'idle'}>{working ? '●' : '○'}</RailBadge>
      <div className="flex min-h-6 min-w-0 items-center gap-x-2 gap-y-0.5 px-3 py-2 @max-[28rem]/row:flex-wrap">
        <span aria-hidden className="w-3 shrink-0" />
        {!quiet && (
          <span aria-hidden className="w-5 shrink-0 text-center text-[15px] leading-none">
            {working ? '▶' : '◦'}
          </span>
        )}
        <span className="min-w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('upNext.nowLabel', 'Now')}
        </span>
        <strong className="min-w-0 max-w-[60%] truncate text-sm font-semibold @max-[28rem]/row:max-w-none @max-[28rem]/row:flex-1">
          {now.kind === 'idle'
            ? t('upNext.idle', 'idle')
            : now.label || t('upNext.working', 'working')}
        </strong>
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground @max-[28rem]/row:basis-full @max-[28rem]/row:pl-[6.5rem]"
          title={summary || undefined}
        >
          {summary}
        </span>
      </div>
    </div>
  )
}
