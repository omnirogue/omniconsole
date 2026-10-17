import React from 'react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { advertisingApi, useAdvertisingRead } from './advertising-client'
import { count, money, percent, stamp, UNKNOWN } from './advertising-format'
import { matchTodayWebinarSpend } from './webinar-spend-match'
import {
  confirmedFullCompletion,
  type SalesAdsReport,
  type WebinarWindow
} from '../../../../shared/console-advertising-contract'

const WINDOWS: readonly { window: WebinarWindow; label: () => string }[] = [
  { window: 'today', label: () => translate('advertising.webinarToday', 'Today') },
  { window: 'd7', label: () => translate('advertising.webinar7', 'Last 7 complete days') }
]

/**
 * Enterprise's first-party funnel. These are WebinarJam's own counts of signups,
 * attendance and confirmed completion — a DIFFERENT population from the Meta
 * registrations and Leads in the campaign table above, measured on a different
 * calendar. Only today's same-date, same-timezone, same-ad-set observations can
 * produce a per-ID cost; the full-cohort headline deliberately stays separate.
 */
function WebinarPeriod({
  window,
  label,
  revision,
  adSetReport
}: {
  window: WebinarWindow
  label: string
  revision: number
  adSetReport: SalesAdsReport | null
}): React.JSX.Element {
  const read = useAdvertisingRead(
    () => advertisingApi().webinar({ window }),
    `webinar:${window}:${revision}`
  )
  const envelope = read.data
  const summary = envelope?.data ?? null
  const metrics = summary?.metrics ?? null
  const full = metrics ? confirmedFullCompletion(metrics) : null
  const stale = envelope?.status === 'stale'
  const matched =
    window === 'today' && envelope?.status === 'ready'
      ? matchTodayWebinarSpend(adSetReport, summary)
      : null
  return (
    <div className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium">{label}</h4>
        {stale ? (
          <Badge variant="outline" className="text-[10px]">
            {translate('advertising.lastKnown', 'Last known data')}
          </Badge>
        ) : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {read.loading
          ? translate('advertising.loading', 'Loading…')
          : summary
            ? translate(
                'advertising.webinarCohort',
                '{{start}} → {{end}} · {{zone}} signup cohort · observed {{asOf}}',
                {
                  start: summary.cohort.start.slice(0, 10),
                  end: summary.cohort.end.slice(0, 10),
                  zone: summary.cohort.time_zone,
                  asOf: stamp(summary.as_of, summary.cohort.time_zone)
                }
              )
            : translate('advertising.webinarUnavailable', 'WebinarJam data unavailable.')}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th scope="col" className="px-2 py-1.5 font-medium">
                {translate('advertising.webinarResult', 'WebinarJam result')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                {translate('advertising.count', 'Count')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                {translate('advertising.costPerResult', 'Cost per result')}
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              {
                label: translate('advertising.webinarSignups', 'Actual webinar signups'),
                value: metrics?.registrations ?? null
              },
              {
                label: translate('advertising.webinarAttended', 'Attended (live or replay)'),
                value: metrics?.attended ?? null
              },
              {
                label: translate('advertising.webinarFull', 'Confirmed full completion'),
                value: full
              }
            ].map((entry) => (
              <tr key={entry.label} className="border-t">
                <th scope="row" className="px-2 py-1.5 font-normal">
                  {entry.label}
                </th>
                <td className="px-2 py-1.5 text-right tabular-nums">{count(entry.value)}</td>
                <td className="px-2 py-1.5 text-right text-muted-foreground">{UNKNOWN}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {metrics ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('advertising.webinarAttendance', 'Attendance rate {{rate}}', {
            rate: percent(metrics.attendance_rate)
          })}
          {metrics.completion_unknown_attendees !== undefined &&
          metrics.completion_unknown_attendees > 0
            ? ` · ${translate(
                'advertising.completionUnknown',
                'completion unknown for {{count}} attendees, so full completion is withheld',
                { count: metrics.completion_unknown_attendees }
              )}`
            : ''}
          {summary && summary.attribution.unattributed_adset_registrations > 0
            ? ` · ${translate(
                'advertising.unattributedSignups',
                '{{count}} signups have no usable ad-set attribution',
                { count: summary.attribution.unattributed_adset_registrations }
              )}`
            : ''}
        </p>
      ) : null}
      {window === 'today' && matched ? (
        <div className="space-y-2">
          <h5 className="text-xs font-medium">
            {translate('advertising.matchedWebinarCosts', 'ID-matched Enterprise ad-set costs')}
          </h5>
          {matched.withheld ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {translate(
                'advertising.matchedCostUnavailable',
                'Cost match unavailable: {{reason}}',
                {
                  reason: matched.withheld
                }
              )}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[550px] text-left text-xs">
                <thead className="bg-muted/40">
                  <tr>
                    <th scope="col" className="px-2 py-1.5 font-medium">
                      {translate('advertising.adSet', 'Ad set')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      {translate('advertising.spend', 'Spend')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      {translate('advertising.perRegistration', 'Cost / reg')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      {translate('advertising.perAttendee', 'Cost / attendee')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right font-medium">
                      {translate('advertising.perFullWatch', 'Cost / full watch')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matched.rows.map((row) => (
                    <tr key={row.id} className="border-t">
                      <th
                        scope="row"
                        title={translate('advertising.metaAdSetId', 'Meta ad-set ID {{id}}', {
                          id: row.id
                        })}
                        className="px-2 py-1.5 font-normal"
                      >
                        {row.name}
                      </th>
                      <td className="px-2 py-1.5 text-right">{money(row.spend)}</td>
                      <td className="px-2 py-1.5 text-right">
                        {money(row.costPerRegistration)} ({count(row.registrations)})
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {money(row.costPerAttendee)} ({count(row.attended)})
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {money(row.costPerFull)} ({count(row.full)})
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'advertising.matchedCostScope',
              'Today only; matched Meta ad-set IDs and a common timezone/date with observations within 15 minutes. {{count}} webinar signups are unmatched and excluded. These are signup-cohort costs, not Meta attribution or net profit.',
              { count: matched.unmatchedRegistrations }
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export function EnterpriseFunnelPanel({
  revision,
  adSetReport = null
}: {
  revision: number
  adSetReport?: SalesAdsReport | null
}): React.JSX.Element {
  return (
    <section
      className="space-y-3 rounded-xl border bg-card p-4"
      aria-label={translate('advertising.enterpriseRegion', 'Enterprise actual acquisition')}
      data-testid="enterprise-funnel"
    >
      <div>
        <h3 className="text-sm font-semibold">
          {translate('advertising.enterpriseFunnel', 'Enterprise · actual WebinarJam results')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'advertising.enterpriseFunnelNote',
            'Meta registrations and Leads are in the campaign table. These are WebinarJam’s own signups, attendance and completion — a different population on a different calendar.'
          )}
        </p>
      </div>
      {WINDOWS.map((entry) => (
        <WebinarPeriod
          key={entry.window}
          window={entry.window}
          label={entry.label()}
          revision={revision}
          adSetReport={adSetReport}
        />
      ))}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'advertising.webinarCostNote',
          'Only today’s exact ID-matched ad sets can show webinar costs. The seven-day WebinarJam cohort excludes today while the Meta range includes it, so no seven-day cost is calculated. The Enterprise Meta bridge emits Lead for attendance with positive watch time, not full completion.'
        )}
      </p>
    </section>
  )
}
