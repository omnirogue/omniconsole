import React from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { Stat } from './stats-model'

const TONE: Record<NonNullable<Stat['tone']>, string> = {
  neutral: '',
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-rose-600 dark:text-rose-400'
}

/**
 * How a figure is written. A loss carries a minus sign as well as a colour, so the
 * sign survives greyscale and colour blindness, and a figure nobody read prints an
 * em dash rather than a zero.
 */
export function statText(stat: Stat): string {
  const value = stat.value
  if (value === null) {
    return '—'
  }
  switch (stat.kind) {
    case 'money': {
      const magnitude = Math.abs(value)
      const text = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: magnitude >= 1000 ? 0 : 2
      }).format(magnitude)
      // U+2212, not a hyphen: a real minus sign reads as one at small sizes.
      return value < 0 ? `−${text}` : text
    }
    case 'percent': {
      const text = `${Math.abs(value).toFixed(value % 1 === 0 ? 0 : 1)}%`
      return value < 0 ? `−${text}` : text
    }
    case 'hours':
      return value < 1 ? `${Math.round(value * 60)}m` : `${value.toFixed(value >= 10 ? 0 : 1)}h`
    case 'ratio':
      return `${value.toFixed(2)}×`
    case 'count':
      return value.toLocaleString('en-US', { maximumFractionDigits: 0 })
  }
}

/** One figure, its caption, and — when it is missing — why. */
export function StatTile({ stat }: { stat: Stat }): React.JSX.Element {
  const text = statText(stat)
  return (
    <div
      className="min-w-0"
      data-stat={stat.id}
      data-stat-empty={stat.value === null ? '' : undefined}
    >
      <div className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
        {stat.label}
      </div>
      <div
        className={cn(
          'mt-0.5 truncate text-lg font-semibold tabular-nums',
          stat.value === null ? 'text-muted-foreground' : TONE[stat.tone ?? 'neutral']
        )}
        title={stat.withheld}
      >
        {text}
      </div>
      {stat.withheld ? (
        <div
          className="truncate text-[11px] text-amber-700 dark:text-amber-400"
          title={stat.withheld}
        >
          {stat.withheld}
        </div>
      ) : stat.caption ? (
        <div className="truncate text-[11px] text-muted-foreground" title={stat.caption}>
          {stat.caption}
        </div>
      ) : null}
    </div>
  )
}

export function StatGrid({ stats }: { stats: readonly Stat[] }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {stats.map((stat) => (
        <StatTile key={stat.id} stat={stat} />
      ))}
    </dl>
  )
}

/**
 * A collapsible area of the Work home, with its own freshness and failed-source
 * line so a broken customer-service read never makes the finance figures look
 * suspect.
 */
export function StatSection({
  title,
  subtitle,
  note,
  failed,
  defaultOpen = false,
  children
}: {
  title: string
  subtitle?: string
  note?: string | null
  failed?: readonly string[]
  defaultOpen?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details className="rounded-xl border bg-card" open={defaultOpen} data-stat-section={title}>
      <summary className="cursor-pointer px-4 py-3">
        <span className="text-sm font-semibold">{title}</span>
        {subtitle ? <span className="ml-2 text-xs text-muted-foreground">{subtitle}</span> : null}
      </summary>
      <div className="space-y-4 border-t px-4 py-4">
        {failed && failed.length > 0 ? (
          <p role="alert" className="text-[11px] text-amber-700 dark:text-amber-400">
            {translate('work.sectionSourcesFailed', 'Sources that did not answer: {{list}}.', {
              list: failed.join(', ')
            })}
          </p>
        ) : null}
        {children}
        {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      </div>
    </details>
  )
}
