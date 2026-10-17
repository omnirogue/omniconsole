import { cn } from '@/lib/utils'
import type { UpNextBlock } from '../../../../shared/up-next-types'

/**
 * The track's geometry, in one place (amendment 10). The rail is a 2px line 18px in from the
 * track's left edge; every row sits 34px in; every badge is a 20px circle centred on the rail
 * and on the vertical centre of its row's first line (24px tall under 8px of padding → 10px
 * from the card's top edge). A nested prompt sits a further 28px in with a stub back to the rail.
 *
 * Absolute children measure from the card's PADDING box, so the card's own left border counts:
 * a row card has a 3px left border (padding box at 37px), a dashed placeholder a 1px one (35px).
 * Both offsets below land the badge's left edge at 8px, its centre on the rail at 18px.
 */
export const RAIL_TRACK_CLASS =
  'relative pl-[34px] before:absolute before:top-3 before:bottom-3 before:left-[17px] before:w-0.5 before:bg-border'
const BADGE_CLASS =
  'absolute top-2.5 z-[1] flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-border bg-background px-1 text-[11px] font-semibold leading-none text-muted-foreground'
/** 37px − 29px = 8px from the track's edge, behind a row card's 3px left border. */
const BADGE_ON_RAIL = '-left-[29px]'
/** 35px − 27px = 8px, behind a 1px border: the empty slot and the ghost row pass this in. */
export const BADGE_ON_RAIL_THIN = '-left-[27px]'
/** The nested pill sits between the stub and the row, as the mockup draws it. */
const BADGE_NESTED = 'top-3 -left-[22px] h-4 min-w-4 rounded-md px-1 text-[9px]'

export type RailBadgeTone =
  | 'queued'
  | 'running'
  | 'done'
  | 'needs-you'
  | 'failed'
  | 'recovering'
  | 'now'
  | 'idle'

export function railBadgeTone(block: Pick<UpNextBlock, 'state'>): RailBadgeTone {
  switch (block.state) {
    case 'running':
      return 'running'
    case 'done':
      return 'done'
    case 'needs-you':
      return 'needs-you'
    case 'failed':
      return 'failed'
    case 'recovering':
      return 'recovering'
    case 'draft':
    case 'queued':
    case 'waiting':
      return 'queued'
  }
}

export function railBadgeGlyph(block: Pick<UpNextBlock, 'state' | 'number'>): string {
  switch (block.state) {
    case 'done':
      return '✓'
    case 'running':
      return '●'
    case 'needs-you':
      return '?'
    case 'failed':
      return '!'
    case 'recovering':
      return '↻'
    case 'draft':
    case 'queued':
    case 'waiting':
      return block.number
  }
}

/**
 * One number circle on the rail. State is the ring: blue running or recovering, green done, amber
 * for an open request, red for a failure.
 *
 * Every tone keeps the opaque `bg-background` so the rail never shows through the circle; the
 * done, needs-you and failed tints are 10%-alpha tokens, so they go on as a background IMAGE (a flat
 * gradient) over it rather than replacing it.
 */
export function RailBadge({
  tone,
  nested = false,
  dashed = false,
  className,
  children
}: {
  tone: RailBadgeTone
  nested?: boolean
  dashed?: boolean
  /** The offset for a card whose left border is not 3px (`BADGE_ON_RAIL_THIN`). */
  className?: string
  /** Absent for the dashed placeholders (the empty slot, the ghost row). */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-up-next-rail-badge={tone}
      className={cn(
        BADGE_CLASS,
        nested ? BADGE_NESTED : BADGE_ON_RAIL,
        dashed && 'border-dashed',
        tone === 'running' &&
          'border-status-info bg-status-info text-background motion-safe:animate-pulse',
        tone === 'now' &&
          'border-status-info bg-status-info text-background motion-safe:animate-pulse',
        tone === 'idle' && 'border-muted-foreground/40 bg-muted text-muted-foreground',
        tone === 'done' &&
          'border-status-success bg-linear-to-b from-status-success-background to-status-success-background text-status-success',
        tone === 'needs-you' &&
          'border-status-warning bg-linear-to-b from-status-warning-background to-status-warning-background text-status-warning',
        tone === 'failed' &&
          'border-destructive bg-linear-to-b from-destructive/10 to-destructive/10 text-destructive',
        tone === 'recovering' && 'border-status-info text-status-info',
        className
      )}
    >
      {children}
    </span>
  )
}

/**
 * The stub from the rail to a nested prompt row: the rail's right edge (19px) to the pill's
 * left edge (43px), measured from the nested card's padding box at 34 + 28 + 3 = 65px.
 */
export const NESTED_STUB_CLASS =
  'ml-7 before:absolute before:top-[19px] before:-left-[46px] before:h-0.5 before:w-[24px] before:bg-border'

/** The stop mark under a handoff or Done: a small square centred on the rail (amendment 4). */
export function RailStop({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="relative min-h-4 text-[11px] leading-4 text-muted-foreground" data-up-next-stop>
      <span aria-hidden className="absolute top-[3px] -left-[21px] size-2.5 bg-foreground" />
      {label}
    </p>
  )
}

/**
 * The ↩ on the rail beside a Person review: the track comes back after they reply. Anchored to
 * the card's bottom edge, so a wrapped row does not leave it mid-card.
 */
export function RailReturn(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="absolute -bottom-2 z-[1] -left-[29px] w-5 bg-background text-center text-xs font-bold leading-none text-status-warning"
    >
      ↩
    </span>
  )
}
