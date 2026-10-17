import React from 'react'
import { DivisionMark } from '@/components/companies/DivisionMark'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { divisionStats, type DivisionStat } from './division-stats'
import type { ScorecardDocument } from '../../../../shared/console-scorecard-contract'

/**
 * Every division of one company, each with one figure saying how it is doing.
 *
 * The status line reads from the division's OWN work counts, so the card can never
 * disagree with the page a click lands on. A headline that was suppressed shows the
 * reason in its place rather than nothing — an unavailable source must never read as a
 * quiet division, which is the whole failure mode this grid had to avoid.
 */
function DivisionCard({ division }: { division: DivisionStat }): React.JSX.Element {
  const blocked = division.blocked ?? 0
  const running = division.inProgress ?? 0
  const live = division.live ?? 0
  const status =
    blocked > 0
      ? {
          text: translate('work.division.blocked', '{{count}} blocked', { count: blocked }),
          tone: 'text-rose-600 dark:text-rose-400'
        }
      : running > 0
        ? {
            text: translate('work.division.executing', '{{count}} executing', { count: running }),
            tone: 'text-sky-700 dark:text-sky-400'
          }
        : live > 0
          ? {
              text: translate('work.division.active', '{{count}} active', { count: live }),
              tone: ''
            }
          : { text: translate('work.division.quiet', 'Quiet'), tone: 'text-muted-foreground' }
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
      data-division={division.key}
      data-division-kind={division.kind}
    >
      <div className="flex min-w-0 items-center gap-2">
        <DivisionMark name={division.name} className="size-5 shrink-0 rounded" />
        <span className="min-w-0 truncate text-sm font-medium">{division.name}</span>
      </div>
      {division.headline.primary !== null ? (
        <div className="min-w-0" data-division-headline="">
          <div className="truncate text-base font-semibold tabular-nums">
            {division.headline.primary}
          </div>
          {division.headline.secondary !== null ? (
            <div className="truncate text-[11px] text-muted-foreground tabular-nums">
              {division.headline.secondary}
            </div>
          ) : null}
        </div>
      ) : division.headline.withheld !== null ? (
        <p
          className="text-[11px] text-amber-700 dark:text-amber-400"
          data-division-headline="withheld"
          title={division.headline.withheld}
        >
          {division.headline.withheld}
        </p>
      ) : null}
      <div className={cn('text-xs tabular-nums', status.tone)}>{status.text}</div>
    </div>
  )
}

export function DivisionGrid({
  document,
  slug
}: {
  document: ScorecardDocument | null | undefined
  slug: string
}): React.JSX.Element {
  const divisions = React.useMemo(() => divisionStats(document, slug), [document, slug])
  if (divisions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'work.division.none',
          'The collector did not split this company’s work by division.'
        )}
      </p>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-division-grid={divisions.length}>
      {divisions.map((division) => (
        <DivisionCard key={division.key} division={division} />
      ))}
    </div>
  )
}
