import React from 'react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { money, profitTone, ratio, stamp, UNKNOWN } from './advertising-format'
import type { AdSegment, AdTotals, FreshnessNote } from './advertising-model'

/**
 * One book's result for the chosen window. Spend and Meta-attributed revenue sit
 * together; the difference between them is labelled for what it is and never
 * called profit, because no other cost has been subtracted.
 */
export function AdSegmentCard({
  segment,
  totals,
  selected,
  freshness,
  loading,
  onSelect
}: {
  segment: AdSegment
  totals: AdTotals
  selected: boolean
  freshness: FreshnessNote | null
  loading: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`ad-segment-${segment.id}`}
      data-selected={selected ? '' : undefined}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-colors',
        'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'border-primary ring-1 ring-primary'
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{segment.name}</h3>
          <p className="truncate text-xs text-muted-foreground">{segment.kind}</p>
        </div>
        {totals.partial ? (
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {translate('advertising.partial', 'Partial')}
          </Badge>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {translate('advertising.spend', 'Spend')}
          </dt>
          <dd className="truncate text-lg font-semibold tabular-nums">{money(totals.spend)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {translate('advertising.metaRevenue', 'Meta revenue')}
          </dt>
          <dd className="truncate text-lg font-semibold tabular-nums">{money(totals.revenue)}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {translate('advertising.revenueLessSpend', 'Attributed revenue less ad spend')}
          </div>
          <div
            className={cn(
              'truncate text-base font-semibold tabular-nums',
              profitTone(totals.profit)
            )}
          >
            {money(totals.profit)}
          </div>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {totals.roas === null
            ? translate('advertising.roasUnknown', '— ROAS')
            : translate('advertising.roasValue', '{{value}} ROAS', { value: ratio(totals.roas) })}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {loading
          ? translate('advertising.updating', 'Updating…')
          : freshness
            ? translate('advertising.observed', 'Observed {{when}}', {
                when: stamp(
                  freshness.observedAt ?? freshness.reportedAt,
                  freshness.timezone ?? undefined
                )
              })
            : translate('advertising.reportUnavailable', 'Report unavailable')}
        {totals.unmeasured > 0
          ? ` · ${translate('advertising.unmeasured', '{{count}} without insights', {
              count: totals.unmeasured
            })}`
          : ''}
      </p>
      {/* Why: the three costs Sal judges an account on, where he can see them without opening the table. */}
      <dl className="grid grid-cols-3 gap-2 border-t pt-3 text-xs">
        {[
          {
            label: translate('advertising.cpcLink', 'Link CPC'),
            value: money(totals.costPerClick)
          },
          {
            label: translate('advertising.costPerRegistration', 'Cost / registration'),
            value: money(totals.costPerRegistration)
          },
          {
            label: translate('advertising.costPerPurchase', 'Cost / purchase'),
            value: money(totals.costPerPurchase)
          }
        ].map((entry) => (
          <div key={entry.label} className="min-w-0">
            <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">
              {entry.label}
            </dt>
            <dd className="truncate font-medium tabular-nums">{entry.value || UNKNOWN}</dd>
          </div>
        ))}
      </dl>
    </button>
  )
}
