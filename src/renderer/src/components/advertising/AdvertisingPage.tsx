import React, { useMemo, useState } from 'react'
import { CompaniesNotice, Figure, SectionTitle } from '@/components/companies/CompaniesNotice'
import { companiesApi, useCompaniesRead } from '@/components/companies/companies-client'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { AdCampaignTable } from './AdCampaignTable'
import { AdCoverageDetails } from './AdCoverageDetails'
import { AdvertisingHeader } from './AdvertisingHeader'
import { AdRoutinePanel } from './AdRoutinePanel'
import { AdSegmentCard } from './AdSegmentCard'
import { EnterpriseFunnelPanel } from './EnterpriseFunnelPanel'
import { StripeCashPanel } from './StripeCashPanel'
import { advertisingApi, useAdvertisingRead } from './advertising-client'
import { money, profitTone, rangeLabel, ratio } from './advertising-format'
import {
  AD_SEGMENTS,
  campaignGroups,
  combineTotals,
  comparableWindows,
  freshnessOf,
  routineContext,
  segmentTotals,
  UNKNOWN_TOTALS,
  type AdSegmentId
} from './advertising-model'
import {
  coordinatorInstanceId,
  normalizeCompany,
  type SalesCompany,
  type SalesRangeDays
} from '../../../../shared/console-advertising-contract'

const ACCOUNTS: readonly SalesCompany[] = ['omnirogue', 'betacorp']
const ACCOUNT_NAME: Record<SalesCompany, () => string> = {
  omnirogue: () => translate('advertising.omnirogue', 'OmniRogue'),
  betacorp: () => translate('advertising.betacorp', 'BetaCorp')
}

/**
 * Advertising — the native view. Today first, in the account's own timezone, with
 * OmniRogue split into Enterprise and DTC beside BetaCorp.
 *
 * Four facts stay four facts here: actual spend, the active daily budget the
 * routine reports, Meta-attributed revenue, and Stripe cash collected. Nothing
 * adds across that line, and a figure no source reported prints an em dash.
 *
 * Reads only. No pause, budget, coordinator or connection control lives on this
 * page; each of those needs its own reviewed operation and explicit authorization.
 */
export default function AdvertisingPage(): React.JSX.Element {
  const account = useAppStore((state) => state.activeOrcaProfileId)
  const environment = useAppStore(
    (state) =>
      `${state.settings?.backofficeEnv}:${state.settings?.backofficeLocalUrl}:${state.settings?.backofficeProductionUrl}`
  )
  const [rangeDays, setRangeDays] = useState<SalesRangeDays>(1)
  const [selected, setSelected] = useState<AdSegmentId>('enterprise')
  const [liveOnly, setLiveOnly] = useState(true)
  const [revision, setRevision] = useState(0)
  const segment = AD_SEGMENTS.find((entry) => entry.id === selected) ?? AD_SEGMENTS[0]
  const key = (suffix: string): string =>
    `${account}:${environment}:${rangeDays}:${revision}:${suffix}`

  // Campaign level for both accounts: the cards, and the portfolio line above them.
  const omnirogueCampaigns = useAdvertisingRead(
    () =>
      advertisingApi().salesAds({
        company: 'omnirogue',
        rangeDays,
        level: 'campaign',
        state: 'all'
      }),
    key('omnirogue:campaign')
  )
  const betacorpCampaigns = useAdvertisingRead(
    () =>
      advertisingApi().salesAds({
        company: 'betacorp',
        rangeDays,
        level: 'campaign',
        state: 'all'
      }),
    key('betacorp:campaign')
  )
  // Ad sets for the selected account only: the detail table's second level.
  const adSets = useAdvertisingRead(
    () =>
      advertisingApi().salesAds({
        company: segment.company,
        rangeDays,
        level: 'adset',
        state: 'all'
      }),
    key(`${segment.company}:adset`)
  )
  const scorecard = useCompaniesRead(() => companiesApi().scorecard(), key('scorecard'))
  const adOps = useAdvertisingRead(() => advertisingApi().adOps(), key('adops'))

  const instanceId = useMemo(
    () => (adOps.data ? coordinatorInstanceId(adOps.data, segment.company) : null),
    [adOps.data, segment.company]
  )
  const decision = useAdvertisingRead(
    () =>
      advertisingApi().decision({
        instanceId: instanceId ?? '',
        section: 'overview',
        offset: 0,
        limit: 10
      }),
    key(`decision:${instanceId ?? 'none'}`),
    instanceId !== null
  )

  const reports: Record<
    SalesCompany,
    ReturnType<typeof freshnessOf> extends never ? never : typeof omnirogueCampaigns.data
  > = { omnirogue: omnirogueCampaigns.data, betacorp: betacorpCampaigns.data }
  const totals = AD_SEGMENTS.map((entry) =>
    segmentTotals(reports[entry.company], entry.filter, 'campaign')
  )
  // Why: two accounts may only be added when they covered the same dates.
  const sameWindow = comparableWindows(omnirogueCampaigns.data, betacorpCampaigns.data)
  const accountTotals = ACCOUNTS.map((company) => segmentTotals(reports[company]))
  const portfolio = sameWindow ? combineTotals(accountTotals) : UNKNOWN_TOTALS
  const unclassified = segmentTotals(omnirogueCampaigns.data, 'other', 'campaign')
  const selectedIndex = AD_SEGMENTS.findIndex((entry) => entry.id === selected)
  const selectedTotals = totals[selectedIndex] ?? UNKNOWN_TOTALS
  const selectedReport = reports[segment.company]
  // Why the company check, and not the read hook's key: the hook clears its data in an
  // effect, which runs AFTER the render that follows picking a different segment. For
  // that one render the new company's campaigns would be grouped with the previous
  // company's ad sets, and the table would show another account's spend under this
  // account's heading. An answer only paints for the company it belongs to.
  const selectedAdSets = adSets.data?.company === segment.company ? adSets.data : null
  const unconfirmedLiveAdSets =
    selectedAdSets?.rows.filter(
      (row) =>
        row.level === 'adset' &&
        row.status?.toUpperCase() === 'ACTIVE' &&
        row.effective_status?.toUpperCase() !== 'ACTIVE'
    ).length ?? 0
  const groups = useMemo(
    () =>
      campaignGroups(
        (selectedReport?.rows ?? []).filter(
          (row) => row.level === 'campaign' && (!segment.filter || row.segment === segment.filter)
        ),
        (selectedAdSets?.rows ?? []).filter(
          (row) => row.level === 'adset' && (!segment.filter || row.segment === segment.filter)
        ),
        { liveOnly }
      ),
    [selectedReport, selectedAdSets, segment.filter, liveOnly]
  )
  // The same fence on the coordinator's answer, which carries its own company name.
  const selectedDecision =
    decision.data && normalizeCompany(decision.data.company) === normalizeCompany(segment.company)
      ? decision.data
      : null
  const busy =
    omnirogueCampaigns.loading || betacorpCampaigns.loading || adSets.loading || scorecard.loading
  const refresh = (): void => setRevision((value) => value + 1)

  // Both accounts refusing the same way is a connection problem, not a report.
  if (omnirogueCampaigns.error && betacorpCampaigns.error) {
    return (
      <div className="flex h-full flex-col bg-background" data-testid="advertising-page">
        <AdvertisingHeader
          rangeDays={rangeDays}
          onRange={setRangeDays}
          busy={busy}
          onRefresh={refresh}
        />
        <CompaniesNotice error={omnirogueCampaigns.error} onRetry={refresh} />
      </div>
    )
  }

  return (
    <div
      key={`${account}:${environment}`}
      data-testid="advertising-page"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <AdvertisingHeader
        rangeDays={rangeDays}
        onRange={setRangeDays}
        busy={busy}
        onRefresh={refresh}
      />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          <section
            className="flex flex-wrap items-end justify-between gap-4 rounded-xl border bg-card p-4"
            aria-label={translate('advertising.allAccountsRegion', 'All advertising accounts')}
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                {translate('advertising.allAccounts', '{{range}} · all accounts', {
                  range: rangeLabel(rangeDays)
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate('advertising.metaAttributed', 'Meta-attributed performance · USD')}
              </p>
            </div>
            <dl className="flex flex-wrap gap-6">
              <Figure
                label={translate('advertising.totalSpend', 'Total spend')}
                value={money(portfolio.spend)}
              />
              <Figure
                label={translate('advertising.totalRevenue', 'Total Meta revenue')}
                value={money(portfolio.revenue)}
              />
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">
                  {translate('advertising.revenueLessSpend', 'Attributed revenue less ad spend')}
                </div>
                <div
                  className={cn(
                    'mt-0.5 text-lg font-semibold tabular-nums',
                    profitTone(portfolio.profit)
                  )}
                >
                  {money(portfolio.profit)}
                </div>
              </div>
              <Figure
                label={translate('advertising.roas', 'ROAS')}
                value={portfolio.roas === null ? null : ratio(portfolio.roas)}
              />
            </dl>
            {!sameWindow ? (
              <p className="w-full text-[11px] text-amber-700 dark:text-amber-400">
                {translate(
                  'advertising.windowMismatch',
                  'The two accounts reported different date windows, so their totals are not added. Each card below still shows its own account.'
                )}
              </p>
            ) : null}
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            {ACCOUNTS.map((company, index) => (
              <section
                key={company}
                className="rounded-xl border bg-card p-4"
                aria-label={ACCOUNT_NAME[company]()}
              >
                <p className="text-sm font-semibold">
                  {ACCOUNT_NAME[company]()}
                  {accountTotals[index].partial
                    ? ` · ${translate('advertising.partial', 'Partial')}`
                    : ''}
                </p>
                <p className="mb-3 text-xs text-muted-foreground">
                  {reports[company]
                    ? `${reports[company].date_start} – ${reports[company].date_stop} · ${reports[company].timezone}`
                    : '—'}
                </p>
                <dl className="flex flex-wrap gap-6">
                  <Figure
                    label={translate('advertising.totalSpend', 'Total spend')}
                    value={money(accountTotals[index].spend)}
                  />
                  <Figure
                    label={translate('advertising.totalRevenue', 'Total Meta revenue')}
                    value={money(accountTotals[index].revenue)}
                  />
                </dl>
              </section>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {AD_SEGMENTS.map((entry, index) => (
              <AdSegmentCard
                key={entry.id}
                segment={entry}
                totals={totals[index]}
                selected={entry.id === selected}
                freshness={freshnessOf(reports[entry.company])}
                loading={
                  entry.company === 'omnirogue'
                    ? omnirogueCampaigns.loading
                    : betacorpCampaigns.loading
                }
                onSelect={() => setSelected(entry.id)}
              />
            ))}
          </div>

          {/* Each account's own refusal, named, rather than a silent empty card. */}
          {ACCOUNTS.map((company) => {
            const read = company === 'omnirogue' ? omnirogueCampaigns : betacorpCampaigns
            return read.error ? (
              <p
                key={company}
                role="alert"
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400"
              >
                {translate(
                  'advertising.accountRefused',
                  '{{name}} reporting unavailable: {{detail}}',
                  {
                    name: ACCOUNT_NAME[company](),
                    detail: read.error instanceof Error ? read.error.message : String(read.error)
                  }
                )}
              </p>
            ) : null
          })}

          <StripeCashPanel
            scorecard={scorecard.data}
            rangeDays={rangeDays}
            error={scorecard.error}
          />

          {unclassified.spend !== null || unclassified.revenue !== null ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
              {translate(
                'advertising.unclassified',
                'Unclassified OmniRogue: {{spend}} spend · {{revenue}} Meta revenue, included in the OmniRogue account total. Campaign segment mapping is unavailable.',
                { spend: money(unclassified.spend), revenue: money(unclassified.revenue) }
              )}
            </p>
          ) : null}

          {selected === 'enterprise' ? (
            <EnterpriseFunnelPanel revision={revision} adSetReport={selectedAdSets} />
          ) : null}

          <section
            className="space-y-3"
            aria-label={translate('advertising.detailRegion', 'Advertising detail')}
          >
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <SectionTitle
                  title={translate('advertising.detailTitle', '{{name}} · campaigns and ad sets', {
                    name: segment.name
                  })}
                />
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {translate(
                    'advertising.detailCounts',
                    '{{clicks}} link clicks · {{registrations}} registrations · {{purchases}} Meta purchases',
                    {
                      clicks: selectedTotals.clicks === null ? '—' : String(selectedTotals.clicks),
                      registrations:
                        selectedTotals.registrations === null
                          ? '—'
                          : String(selectedTotals.registrations),
                      purchases:
                        selectedTotals.purchases === null ? '—' : String(selectedTotals.purchases)
                    }
                  )}
                  {selectedTotals.leadEvent === null
                    ? ` · ${translate('advertising.noLeadMapped', 'no Meta Lead event mapped')}`
                    : ` · ${translate('advertising.leadMapped', 'Lead = {{event}}', {
                        event: selectedTotals.leadEvent
                      })}`}
                </p>
              </div>
              <label className="flex shrink-0 items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={liveOnly}
                  onChange={(event) => setLiveOnly(event.target.checked)}
                  className="size-3.5"
                />
                {translate('advertising.liveOnly', 'Live ad sets under enabled campaigns only')}
              </label>
            </div>
            <AdCampaignTable
              groups={groups}
              liveOnly={liveOnly}
              currency={selectedReport?.currency ?? null}
            />
            {liveOnly && unconfirmedLiveAdSets > 0 ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                {translate(
                  'advertising.unconfirmedLive',
                  '{{count}} enabled ad sets are not confirmed to be delivering; they are excluded from live detail, while their measured spend remains in totals.',
                  { count: unconfirmedLiveAdSets }
                )}
              </p>
            ) : null}
            {adSets.error ? (
              <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
                {translate('advertising.adSetsRefused', 'Ad sets could not be read: {{detail}}', {
                  detail:
                    adSets.error instanceof Error ? adSets.error.message : String(adSets.error)
                })}
              </p>
            ) : null}
            <AdCoverageDetails
              report={selectedReport}
              totals={selectedTotals}
              rangeDays={rangeDays}
            />
          </section>

          <AdRoutinePanel
            context={routineContext(selectedDecision)}
            decisions={selectedDecision?.decisions ?? []}
            note={
              adOps.error
                ? translate('advertising.routineReadRefused', 'The routine list could not be read.')
                : instanceId === null && adOps.data
                  ? translate(
                      'advertising.coordinatorAmbiguous',
                      'This company has no single account coordinator, so no routine context is shown. The figures above come straight from the provider report.'
                    )
                  : decision.error
                    ? translate(
                        'advertising.routineRefused',
                        'The routine context could not be read.'
                      )
                    : null
            }
          />
        </div>
      </div>
    </div>
  )
}
