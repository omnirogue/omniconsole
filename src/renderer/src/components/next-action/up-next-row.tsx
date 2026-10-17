import { NEXT_STEP_ACTION_GLYPH } from '../../../../shared/next-step-glyphs'
import type { ReactNode } from 'react'
import { translate as t } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { upNextIsEndCap } from '../../../../shared/up-next-order'
import type { UpNextBlock } from '../../../../shared/up-next-types'
import { blockKindLabel, stateLabel } from './up-next-labels'
import {
  NESTED_STUB_CLASS,
  RailBadge,
  RailReturn,
  railBadgeGlyph,
  railBadgeTone
} from './up-next-rail'
import { UpNextRowControls } from './up-next-row-controls'
import { CHIP_CLASS } from './up-next-chips'

function blockGlyph(block: UpNextBlock): string {
  switch (block.kind) {
    case 'prompt':
      return '💬'
    case 'agent':
      return block.template === 'custom' ? '⚙' : NEXT_STEP_ACTION_GLYPH[block.template]
    case 'person':
      return block.relationship === 'review' ? '👥' : '👤'
    case 'done':
      return '✓'
  }
}

/**
 * One block on the track (amendment 12): chevron · glyph · 11px KIND · 14px title · 12px muted
 * summary · chips · state tag · ↑↓✕ on hover or focus. The title has priority — a natural width
 * capped at 60% — and the summary takes what is left and truncates; nothing here can be wider
 * than the card, whatever the summary says.
 *
 * Why a container query (`@container/row`, `@max-[28rem]/row:`): below 28rem of ROW width the
 * summary drops under the title (`basis-full`) instead of sharing its line. The row, not the
 * window, is what is narrow — the same composer mounts in a popover, a chat header and a card.
 */
export function UpNextRow({
  block,
  title,
  secondary,
  children,
  chips,
  open,
  onOpen,
  onMove,
  onRemove,
  upDisabled,
  downDisabled,
  disabled,
  moved = false,
  now = false,
  wontRun = false,
  status
}: {
  block: UpNextBlock
  title: string
  secondary: ReactNode
  children: ReactNode
  chips?: ReactNode
  open: boolean
  onOpen: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  upDisabled: boolean
  downDisabled: boolean
  disabled: boolean
  moved?: boolean
  now?: boolean
  /** Composed behind a send that does not wait: it stays a draft and never runs from there. */
  wontRun?: boolean
  /** The one line a sent block states under its title, open or folded. */
  status?: ReactNode
}) {
  const cap = upNextIsEndCap(block)
  const nested = block.kind === 'prompt'
  const editable = !block.locked && ['draft', 'queued', 'waiting'].includes(block.state) && !now
  const move = (direction: -1 | 1) => {
    if (editable && !disabled && !cap && !(direction === -1 ? upDisabled : downDisabled)) {
      onMove(direction)
    }
  }
  return (
    <div
      data-up-next-block={block.id}
      data-state={block.state}
      data-kind={block.kind}
      data-intent={block.kind === 'agent' ? block.intent : undefined}
      data-end-cap={cap || undefined}
      data-wont-run={wontRun || undefined}
      className={cn(
        '@container/row group relative min-w-0 rounded-xl border border-l-[3px] bg-card text-card-foreground',
        nested && cn(NESTED_STUB_CLASS, 'border-l-ai-action-accent'),
        // Review stages inspect (violet); handoff stages act on the work (blue).
        block.kind === 'agent' &&
          (block.intent === 'review' ? 'border-l-ai-action-accent' : 'border-l-status-info'),
        block.kind === 'person' && 'border-l-status-warning',
        block.kind === 'done' && 'border-l-status-success',
        moved && 'motion-safe:animate-pulse [animation-iteration-count:1]',
        block.state === 'draft' && 'border-dashed',
        wontRun && 'bg-muted text-muted-foreground opacity-75',
        block.state === 'done' && 'bg-muted text-muted-foreground',
        block.state === 'waiting' && 'opacity-75',
        block.state === 'running' && 'bg-status-info-background ring-2 ring-status-info',
        block.state === 'needs-you' && 'bg-status-warning-background ring-2 ring-status-warning',
        block.state === 'failed' && 'bg-destructive/10 ring-2 ring-destructive',
        block.state === 'recovering' && 'bg-status-info-background',
        cap && 'rounded-b-sm border-b-[3px] border-b-foreground'
      )}
    >
      <RailBadge tone={railBadgeTone(block)} nested={nested} dashed={block.state === 'draft'}>
        {railBadgeGlyph(block)}
      </RailBadge>
      {block.kind === 'person' && block.relationship === 'review' && block.state !== 'done' && (
        <RailReturn />
      )}
      <div className="flex min-w-0 max-w-full flex-wrap items-start gap-x-2 gap-y-1 px-3 py-2">
        <button
          type="button"
          className="flex min-h-6 min-w-0 shrink grow basis-64 items-center gap-x-2 gap-y-0.5 text-left focus-visible:rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring @max-[28rem]/row:flex-wrap"
          aria-expanded={open}
          data-up-next-row={block.id}
          data-up-next-state={block.state}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) {
              return
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen()
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              move(event.key === 'ArrowUp' ? -1 : 1)
            }
            if ((event.key === 'Delete' || event.key === 'Backspace') && editable && !disabled) {
              event.preventDefault()
              onRemove()
            }
          }}
        >
          <span
            aria-hidden
            className="w-3 shrink-0 text-center text-xs leading-none text-muted-foreground"
          >
            {open ? '▾' : '▸'}
          </span>
          <span aria-hidden className="w-5 shrink-0 text-center text-[15px] leading-none">
            {blockGlyph(block)}
          </span>
          {/* The rail badge is decorative; the number a screen reader hears lives here. */}
          <span className="sr-only">{block.number}</span>
          <span className="min-w-12 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {now ? t('upNext.nowLabel', 'Now') : blockKindLabel(block)}
          </span>
          <strong
            data-up-next-title
            className={cn(
              'min-w-0 max-w-[60%] truncate text-sm @max-[28rem]/row:max-w-none @max-[28rem]/row:flex-1',
              block.kind === 'prompt' ? 'font-medium' : 'font-semibold'
            )}
          >
            {title}
          </strong>
          {secondary ? (
            <span
              data-up-next-secondary
              title={typeof secondary === 'string' ? secondary : undefined}
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground @max-[28rem]/row:basis-full @max-[28rem]/row:pl-[6.5rem]"
            >
              {secondary}
            </span>
          ) : null}
        </button>
        <span className="flex min-h-6 min-w-0 max-w-full flex-wrap items-center gap-1">
          {chips}
          {block.state === 'running' && (
            <span aria-label={stateLabel(block.state)} className="text-xs leading-none">
              🔒
            </span>
          )}
          {wontRun ? (
            <span
              data-up-next-wont-run
              className={cn(CHIP_CLASS, 'border-status-warning bg-background text-status-warning')}
            >
              {t('upNext.wontRun', "won't run")}
            </span>
          ) : (
            ['draft', 'waiting', 'recovering', 'needs-you', 'failed'].includes(block.state) && (
              <span
                className={cn(
                  CHIP_CLASS,
                  block.state === 'draft' && 'border-dashed text-muted-foreground',
                  block.state === 'waiting' && 'bg-muted text-muted-foreground',
                  block.state === 'recovering' &&
                    'border-status-info bg-background text-status-info',
                  block.state === 'needs-you' &&
                    'border-status-warning bg-background text-status-warning',
                  block.state === 'failed' && 'border-destructive bg-background text-destructive'
                )}
              >
                {stateLabel(block.state)}
              </span>
            )
          )}
          {editable && (
            <UpNextRowControls
              cap={cap}
              disabled={disabled}
              upDisabled={upDisabled}
              downDisabled={downDisabled}
              onMove={move}
              onRemove={onRemove}
            />
          )}
        </span>
      </div>
      {status}
      {open && (
        <div className="space-y-2 border-t border-border/70 px-3 py-2.5 text-xs">{children}</div>
      )}
    </div>
  )
}
