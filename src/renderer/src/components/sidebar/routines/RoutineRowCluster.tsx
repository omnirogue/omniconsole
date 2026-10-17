import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RoutineRowIndicatorKind } from './routine-row-details'

/**
 * The right edge of a routine row: the quick actions and — on a compact row — the one mark shown
 * at rest. Same idiom as a conversation row: the actions keep their width while transparent and
 * the mark floats over them, so hovering swaps one for the other without moving the row.
 */
export function RoutineRowCluster({
  compact,
  indicator,
  children
}: {
  compact: boolean
  indicator: RoutineRowIndicatorKind | null
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="relative flex shrink-0 items-center" data-routine-row-cluster="">
      {children}
      {compact && indicator ? <RoutineRowIndicator kind={indicator} /> : null}
    </span>
  )
}

/**
 * Sits over the row's action cluster and fades out as the actions fade in. A paused routine keeps
 * its "Paused" word (and `data-routine-paused`) here; a due one shows a warning dot.
 */
export function RoutineRowIndicator({
  kind
}: {
  kind: RoutineRowIndicatorKind
}): React.JSX.Element {
  const shell = cn(
    'pointer-events-none absolute inset-y-0 right-1.5 flex items-center transition-opacity',
    'group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:hidden'
  )
  if (kind === 'paused') {
    return (
      <span
        className={cn(shell, 'text-xs text-muted-foreground')}
        data-routine-row-indicator="paused"
        data-routine-paused=""
      >
        {translate('routines.paused', 'Paused')}
      </span>
    )
  }
  const label = translate('routines.dueNow', 'Due now')
  return (
    <span
      className={shell}
      role="img"
      aria-label={label}
      title={label}
      data-routine-row-indicator="due"
    >
      <span className="size-2 rounded-full bg-status-warning" />
    </span>
  )
}
