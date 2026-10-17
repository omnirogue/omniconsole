import { Button } from '@/components/ui/button'
import { Fragment, type ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import type { WorkLens } from './backoffice-work-labels'

/** The three ways to look at the one list; the first two carry the projection's counts. */
export function BackofficeWorkLensRow({
  lens,
  counts,
  onChange,
  active = true,
  afterWaiting
}: {
  lens: WorkLens
  counts: { needsYou: number; waitingFor: number }
  onChange: (lens: WorkLens) => void
  active?: boolean
  afterWaiting?: ReactNode
}): React.JSX.Element {
  const lenses: { key: WorkLens; label: string; count: number | null }[] = [
    {
      key: 'needs-you',
      label: translate('backofficeWork.tabNeedsYou', 'Needs You'),
      count: counts.needsYou
    },
    {
      key: 'waiting',
      label: translate('backofficeWork.tabWaitingFor', 'Waiting For'),
      count: counts.waitingFor
    },
    { key: 'all', label: translate('backofficeWork.tabAll', 'All'), count: null }
  ]
  return (
    <nav aria-label={translate('backofficeWork.lenses', 'Work lenses')} className="flex gap-1">
      {lenses.map((entry) => (
        <Fragment key={entry.key}>
          <Button
            type="button"
            variant={active && lens === entry.key ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={active && lens === entry.key}
            aria-label={entry.label}
            data-work-lens={entry.key}
            onClick={() => onChange(entry.key)}
          >
            {entry.label}
            {entry.count === null ? null : (
              <span className="tabular-nums text-muted-foreground">{entry.count}</span>
            )}
          </Button>
          {entry.key === 'waiting' ? afterWaiting : null}
        </Fragment>
      ))}
    </nav>
  )
}
