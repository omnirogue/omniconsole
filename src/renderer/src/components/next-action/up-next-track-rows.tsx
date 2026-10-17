import { useId, type ReactNode } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { UpNextBlock } from '../../../../shared/up-next-types'
import { spanLabel } from './up-next-labels'
import { BADGE_ON_RAIL_THIN, RailBadge, RailStop } from './up-next-rail'

/**
 * "✓ 2 done · 20m ▸": finished stages folded into one strip above the Now row (amendment 7).
 * The strip owns the rows it discloses, so its `aria-controls` names the box they open in.
 */
export function DoneStrip({
  done,
  open,
  onToggle,
  children
}: {
  done: UpNextBlock[]
  open: boolean
  onToggle: () => void
  /** The finished rows, rendered only while the strip is open. */
  children?: ReactNode
}): React.JSX.Element {
  const rowsId = useId()
  const durationMs = done.reduce(
    (ms, block) => ms + (block.kind === 'agent' ? (block.progress?.durationMs ?? 0) : 0),
    0
  )
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        className="h-7 w-full justify-start rounded-lg bg-muted/60 px-3 text-muted-foreground"
        aria-expanded={open}
        aria-controls={rowsId}
        onClick={onToggle}
      >
        {t('upNext.doneStrip', '✓ {{count}} done · {{duration}}', {
          count: done.length,
          duration: spanLabel(durationMs)
        })}{' '}
        {open ? '▾' : '▸'}
      </Button>
      {open && (
        <div id={rowsId} className="space-y-1.5" data-up-next-done-rows>
          {children}
        </div>
      )}
    </>
  )
}

/** The dashed slot an empty track shows while the agent is busy (amendment 1). */
export function EmptySlot(): React.JSX.Element {
  return (
    <div className="relative rounded-xl border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
      <RailBadge tone="queued" dashed className={BADGE_ON_RAIL_THIN} />
      {t('upNext.emptySlot', '+ next block goes here')}
    </div>
  )
}

/**
 * What ends the track: a stop mark under a cap, else the non-interactive ghost row (amendment 4).
 * `quiet` is the idle-and-empty track (`idleEmpty`): the dashed slot above is already the end.
 */
export function TrackEnd({
  capped,
  closed,
  quiet = false,
  hideWait = false
}: {
  capped: boolean
  closed: boolean
  quiet?: boolean
  hideWait?: boolean
}) {
  if (capped) {
    return (
      <RailStop
        label={closed ? t('upNext.endedHere', 'ended here') : t('upNext.endsHere', 'ends here')}
      />
    )
  }
  if (closed || quiet || hideWait) {
    return null
  }
  return (
    <div className="relative rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <RailBadge tone="queued" dashed className={BADGE_ON_RAIL_THIN} />
      {t('upNext.ghost', '…then waits for you · tab stays open')}
    </div>
  )
}
