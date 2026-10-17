import React, { useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  trendDomain,
  trendPath,
  type FinancialHistory,
  type TrendMetric
} from './financial-history'
import { statText } from './StatTile'

/** One stable colour per metric, legible on both themes. */
const COLOUR: Record<TrendMetric, string> = {
  revenue: '#3b82f6',
  ad_spend: '#d69b38',
  api_cost: '#8b5cf6',
  pnl: '#10b981'
}

const PLOT = { width: 960, height: 200, left: 58, right: 16, top: 14, bottom: 22 }

const money = (value: number | null): string =>
  statText({ id: 'x', label: '', value, kind: 'money' })

/**
 * Seven complete days of revenue, ad spend, API cost and reported P&L.
 *
 * A missing day is a BREAK in the line, never a straight segment across it: the
 * collector did not measure that day, and a line drawn through it would assert a
 * value nobody read. The legend doubles as the readout, so every number on screen
 * names the day it belongs to and how many companies reported it.
 */
export function FinancialTrend({
  history,
  compact = false
}: {
  history: FinancialHistory | null
  compact?: boolean
}): React.JSX.Element {
  const [active, setActive] = useState<number | null>(null)
  if (!history || history.days.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
        {translate(
          'work.noTrend',
          'No comparable financial history is available for the last seven complete days.'
        )}
      </p>
    )
  }
  const domain = trendDomain(history.series)
  const height = compact ? 148 : PLOT.height
  const plotWidth = PLOT.width - PLOT.left - PLOT.right
  const plotHeight = height - PLOT.top - PLOT.bottom
  const columns = history.days.length
  const x = (index: number): number =>
    PLOT.left + (columns === 1 ? plotWidth / 2 : (index / (columns - 1)) * plotWidth)
  const y = (value: number): number => {
    if (!domain) {
      return PLOT.top + plotHeight / 2
    }
    const span = domain.max - domain.min || 1
    return PLOT.top + plotHeight - ((value - domain.min) / span) * plotHeight
  }
  // Why clamped and not just defaulted: `active` survives a change of `history`, so a
  // day picked in a seven-day window would still be selected in a two-day one. The
  // point lookup would then miss and the legend would read "— gap" for a day that has
  // a figure, while the guide line was drawn outside the plot entirely.
  const day = Math.max(0, Math.min(active ?? columns - 1, columns - 1))
  const ticks = domain ? [domain.max, (domain.max + domain.min) / 2, domain.min] : []
  const compactMoney = (value: number): string =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(value)
  return (
    <div className="space-y-2" data-testid="financial-trend">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium">
          {translate('work.lastSevenDays', 'Last 7 complete days')}
        </h4>
        <span className="text-[11px] text-muted-foreground">
          {translate('work.trendRange', '{{start}} to {{end}}', {
            start: history.start,
            end: history.end
          })}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${PLOT.width} ${height}`}
        className="h-auto w-full"
        role="img"
        aria-label={translate(
          'work.trendLabel',
          'Revenue, ad spend, API cost and reported P&L over seven complete days. Gaps are days a company did not report.'
        )}
      >
        {ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={PLOT.left}
              x2={PLOT.width - PLOT.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="currentColor"
              strokeOpacity={0.12}
              strokeDasharray="3 5"
            />
            <text
              x={PLOT.left - 8}
              y={y(tick) + 3}
              textAnchor="end"
              className="fill-current text-[10px] opacity-50"
            >
              {compactMoney(tick)}
            </text>
          </g>
        ))}
        {/* A real zero line whenever the window dipped below it. */}
        {domain && domain.min < 0 ? (
          <line
            x1={PLOT.left}
            x2={PLOT.width - PLOT.right}
            y1={y(0)}
            y2={y(0)}
            stroke="currentColor"
            strokeOpacity={0.3}
          />
        ) : null}
        <line
          x1={x(day)}
          x2={x(day)}
          y1={PLOT.top}
          y2={PLOT.top + plotHeight}
          stroke="currentColor"
          strokeOpacity={0.18}
        />
        {history.series.map((series) => (
          <g key={series.metric}>
            <path
              d={trendPath(series.points, x, y)}
              fill="none"
              stroke={COLOUR[series.metric]}
              strokeWidth={2}
              strokeLinecap="round"
            />
            {series.points.map((point, index) =>
              point.value === null ? null : (
                <circle
                  key={point.date}
                  cx={x(index)}
                  cy={y(point.value)}
                  r={index === day ? 4 : 2.5}
                  fill={COLOUR[series.metric]}
                />
              )
            )}
          </g>
        ))}
        {history.days.map((date, index) => (
          <text
            key={date}
            x={x(index)}
            y={height - 6}
            textAnchor="middle"
            className="fill-current text-[10px] opacity-50"
          >
            {date.slice(5)}
          </text>
        ))}
      </svg>
      <div
        className="flex flex-wrap gap-1"
        role="group"
        aria-label={translate('work.pickDay', 'Pick a day')}
      >
        {history.days.map((date, index) => (
          <button
            key={date}
            type="button"
            aria-pressed={index === day}
            onPointerEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
            onClick={() => setActive(index)}
            className={`rounded-md border px-1.5 py-0.5 text-[10px] tabular-nums ${
              index === day ? 'bg-accent font-medium' : 'text-muted-foreground'
            }`}
          >
            {date.slice(5)}
          </button>
        ))}
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-trend-legend="" aria-live="polite">
        {history.series.map((series) => {
          const point = series.points[day]
          return (
            <div key={series.metric} className="min-w-0">
              <dt className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: COLOUR[series.metric] }}
                />
                {series.label}
              </dt>
              <dd className="truncate text-sm font-medium tabular-nums">
                {point?.value === null || point === undefined
                  ? translate('work.trendGap', '— gap')
                  : money(point.value)}
              </dd>
              <dd className="truncate text-[10px] text-muted-foreground">
                {series.cohort.length === 0
                  ? translate('work.trendNoCohort', 'no company reported this')
                  : translate(
                      'work.trendCohort',
                      '{{covered}} of {{days}} days · {{n}} companies',
                      {
                        covered: series.covered,
                        days: history.days.length,
                        n: series.cohort.length
                      }
                    )}
              </dd>
            </div>
          )
        })}
      </dl>
      {history.notes.length > 0 ? (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">
            {translate('work.trendCoverage', 'Data coverage · {{count}} notes', {
              count: history.notes.length
            })}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {history.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'work.trendPnlNote',
          'Reported P&L is the collector’s own figure, not revenue less ad spend.'
        )}
      </p>
    </div>
  )
}
