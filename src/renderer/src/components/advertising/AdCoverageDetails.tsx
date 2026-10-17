import React from 'react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { rangeLabel, stamp } from './advertising-format'
import { freshnessOf, type segmentTotals } from './advertising-model'
import type { SalesRangeDays } from '../../../../shared/console-advertising-contract'

/**
 * What the window covered, what it missed, and what is therefore withheld. The
 * honest note beside every figure on the page.
 */
export function AdCoverageDetails({
  report,
  totals,
  rangeDays
}: {
  report: Parameters<typeof freshnessOf>[0]
  totals: ReturnType<typeof segmentTotals>
  rangeDays: SalesRangeDays
}): React.JSX.Element {
  const freshness = freshnessOf(report)
  return (
    <details className="rounded-lg border bg-card p-3 text-xs">
      <summary className="cursor-pointer font-medium">
        {translate('advertising.coverage', 'Data and coverage')}
        {totals.partial ? (
          <Badge variant="outline" className="ml-2 text-[10px]">
            {translate('advertising.partial', 'Partial')}
          </Badge>
        ) : null}
      </summary>
      <div className="mt-2 space-y-1 text-muted-foreground">
        <p>
          {freshness
            ? translate(
                'advertising.coverageWindow',
                '{{start}} to {{stop}} · {{zone}} · observed {{observed}} · received {{received}}',
                {
                  start: freshness.window?.start ?? '—',
                  stop: freshness.window?.stop ?? '—',
                  zone: freshness.timezone ?? '—',
                  observed: stamp(freshness.observedAt, freshness.timezone ?? undefined),
                  received: stamp(freshness.reportedAt, freshness.timezone ?? undefined)
                }
              )
            : translate(
                'advertising.coverageUnavailable',
                'No report was received for this window.'
              )}
        </p>
        <p>
          {translate(
            'advertising.coverageTotals',
            'Account totals include every measured campaign in every status, paused ones included, so {{range}} spend counts even after a pause. They are independent of the filter below.',
            { range: rangeLabel(rangeDays).toLowerCase() }
          )}
        </p>
        {totals.unmeasured > 0 ? (
          <p>
            {translate(
              'advertising.coverageUnmeasured',
              '{{count}} objects reported no insight at all and are excluded from the subtotals rather than counted as zero.',
              { count: totals.unmeasured }
            )}
          </p>
        ) : null}
        {freshness && freshness.failedSources.length > 0 ? (
          <p className="text-amber-700 dark:text-amber-400">
            {translate('advertising.coverageFailed', 'These sources failed: {{list}}.', {
              list: freshness.failedSources.join(', ')
            })}
          </p>
        ) : null}
        {totals.partial ? (
          <p className="text-amber-700 dark:text-amber-400">
            {translate(
              'advertising.coveragePartialNote',
              'This report is incomplete. Measured subtotals are shown; derived profit and ROAS are withheld rather than computed over a partial numerator.'
            )}
          </p>
        ) : null}
        <p>
          {translate(
            'advertising.coverageAttribution',
            'Revenue is Meta-attributed and can lag or miss a Stripe sale. Attributed revenue less ad spend excludes fees and operating costs, so it is not net profit.'
          )}
        </p>
      </div>
    </details>
  )
}
