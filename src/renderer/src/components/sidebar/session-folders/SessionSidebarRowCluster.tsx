import { cn } from '@/lib/utils'
import { ROW_HOVER_REVEAL } from './session-row-reveal'
import {
  SessionSidebarRowIndicator,
  type SessionRowIndicatorKind
} from './SessionSidebarRowIndicator'

/**
 * The right edge of a row: the chevron and the quick actions, and — on a compact row — the one
 * mark shown at rest. Only controls that are showing take width: a compact row folds all of its
 * actions away behind the mark, a comfortable row folds its hover-only ones. It may shrink so the
 * name keeps its floor (`ROW_NAME_FLOOR`).
 */
export function SessionSidebarRowCluster({
  compact,
  indicator,
  children
}: {
  compact: boolean
  indicator: SessionRowIndicatorKind | null
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center" data-session-row-cluster="">
      <span
        className={cn('min-w-0', compact ? ROW_HOVER_REVEAL : 'flex items-center')}
        data-session-row-actions=""
      >
        {children}
      </span>
      {indicator ? <SessionSidebarRowIndicator kind={indicator} /> : null}
    </span>
  )
}
