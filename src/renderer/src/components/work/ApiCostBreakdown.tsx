import React, { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { costDimensionNote, costRows, statNumber, type CostDimension } from './stats-model'
import { statText } from './StatTile'
import type { CostBreakdown } from '../../../../shared/console-scorecard-contract'

const DIMENSIONS: readonly { key: CostDimension; label: () => string }[] = [
  { key: 'by_provider', label: () => translate('work.byProvider', 'By provider') },
  { key: 'by_model', label: () => translate('work.byModel', 'By model') },
  { key: 'by_category', label: () => translate('work.byCategory', 'By category') },
  { key: 'by_agent', label: () => translate('work.byAgent', 'By feature or product') }
]

const money = (value: number | null): string =>
  statText({ id: 'x', label: '', value, kind: 'money' })

/**
 * Where the AI spend went: provider, model, category, and the product it came
 * from. Two windows, one at a time.
 *
 * Three absences are told apart rather than collapsed into one blank: the
 * collector never sent this dimension; it sent it and found nothing; or the cost
 * source failed. Only the middle one is an empty list.
 */
export function ApiCostBreakdown({
  today,
  sevenDays
}: {
  today: CostBreakdown | null | undefined
  sevenDays: CostBreakdown | null | undefined
}): React.JSX.Element {
  const [window, setWindow] = useState<'today' | '7d'>('today')
  const breakdown = window === 'today' ? today : sevenDays
  const other = window === 'today' ? sevenDays : today
  const otherLabel =
    window === 'today'
      ? translate('work.last7', 'last 7 days')
      : translate('work.todayWord', 'today')
  const total = statNumber(breakdown?.total)
  const requests = statNumber(breakdown?.requests)
  return (
    <div className="space-y-3" data-cost-window={window}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs">
          {breakdown === null || breakdown === undefined ? (
            <span className="text-amber-700 dark:text-amber-400">
              {translate(
                'work.costUnavailable',
                'API cost is unavailable: the source coverage is missing or failed.'
              )}
            </span>
          ) : (
            <span className="font-medium tabular-nums">
              {money(total)}
              {requests === null
                ? ''
                : ` · ${translate('work.overRequests', 'over {{count}} requests', { count: requests })}`}
            </span>
          )}
        </p>
        <div
          className="flex gap-1"
          role="group"
          aria-label={translate('work.costWindow', 'Cost window')}
        >
          {(['today', '7d'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={window === value}
              onClick={() => setWindow(value)}
              className={`rounded-md border px-2 py-0.5 text-[11px] ${
                window === value ? 'bg-accent font-medium' : 'text-muted-foreground'
              }`}
            >
              {value === 'today'
                ? translate('work.todayWord', 'today')
                : translate('work.last7', 'last 7 days')}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {DIMENSIONS.map((dimension) => {
          const rows = costRows(breakdown, dimension.key)
          const note = costDimensionNote(breakdown, dimension.key)
          const otherRows = costRows(other, dimension.key)
          return (
            <div key={dimension.key} className="min-w-0 space-y-1">
              <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {dimension.label()}
              </h5>
              {rows === null ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate('work.dimensionNotSent', 'The collector did not send this split yet.')}
                </p>
              ) : rows.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate('work.dimensionEmpty', 'No rows were reported for this window.')}
                </p>
              ) : (
                <ul className="space-y-0.5">
                  {rows.slice(0, 8).map((row) => {
                    const comparison = otherRows?.find((candidate) => candidate.name === row.name)
                    return (
                      <li
                        key={row.name}
                        className="flex items-baseline justify-between gap-2 text-xs"
                        title={
                          comparison
                            ? translate('work.otherWindow', '{{label}}: {{amount}}', {
                                label: otherLabel,
                                amount: money(statNumber(comparison.cost))
                              })
                            : translate(
                                'work.otherWindowMissing',
                                'No {{label}} figure was sent for this row.',
                                { label: otherLabel }
                              )
                        }
                      >
                        <span className="min-w-0 truncate">{row.name}</span>
                        <span className="shrink-0 tabular-nums">{money(statNumber(row.cost))}</span>
                      </li>
                    )
                  })}
                  {rows.length > 8 ? (
                    <li className="text-[11px] text-muted-foreground">
                      {translate('work.moreRows', '{{count}} more rows', {
                        count: rows.length - 8
                      })}
                    </li>
                  ) : null}
                </ul>
              )}
              {note ? (
                <p className="text-[11px] text-amber-700 dark:text-amber-400">{note}</p>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
