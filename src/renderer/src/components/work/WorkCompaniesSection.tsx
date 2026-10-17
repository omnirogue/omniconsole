import React, { useMemo } from 'react'
import { ChevronRight } from 'lucide-react'
import { CompanyMark } from '@/components/companies/CompanyMark'
import { Button } from '@/components/ui/button'
import {
  companiesApi,
  companiesErrorMessage,
  CompaniesRequestError,
  needsOmniosSignIn,
  useCompaniesRead
} from '@/components/companies/companies-client'
import { CompaniesNotice, HealthBadge } from '@/components/companies/CompaniesNotice'
import {
  companyAccessSummary,
  useCompanyAccess,
  useCompanyFolderSet
} from '@/components/companies/company-access'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { WorkSectionTitle } from './WorkSectionTitle'
import {
  companyMoneyRows,
  formatMoney,
  MONEY_FIELDS,
  portfolioToday,
  scorecardAgeMinutes,
  type Money,
  type MoneyField
} from './work-model'

function fieldLabel(field: MoneyField): string {
  switch (field) {
    case 'revenue':
      return translate('work.revenue', 'Revenue')
    case 'ad_spend':
      return translate('work.adSpend', 'Ad spend')
    case 'api_cost':
      return translate('work.apiCost', 'API cost')
    case 'pnl':
      return translate('work.pnl', 'P&L')
  }
}

function unknownLabel(money: Extract<Money, { kind: 'unknown' }>): string {
  switch (money.reason) {
    case 'not-applicable':
      return translate('work.moneyNotApplicable', 'n/a')
    case 'unreported':
      return translate('work.moneyUnreported', 'Unknown')
    case 'missing':
      return translate('work.moneyMissing', 'Unknown')
  }
}

/** A money figure, or the honest word for its absence — never a zero the collector did not report. */
function MoneyFigure({
  label,
  money,
  signed = false,
  large = false
}: {
  label: string
  money: Money
  signed?: boolean
  large?: boolean
}): React.JSX.Element {
  const tone =
    money.kind === 'value' && signed
      ? money.value < 0
        ? 'text-rose-600 dark:text-rose-400'
        : money.value > 0
          ? 'text-emerald-700 dark:text-emerald-400'
          : ''
      : money.kind === 'unknown'
        ? 'text-muted-foreground'
        : ''
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        data-money={label}
        data-money-empty={money.kind === 'unknown' ? '' : undefined}
        className={cn(
          'truncate tabular-nums',
          large ? 'text-xl font-semibold' : 'text-sm font-medium',
          tone
        )}
        title={
          money.kind === 'unknown'
            ? money.reason === 'not-applicable'
              ? translate('work.moneyNotApplicableDetail', 'This company reports no such figure.')
              : translate('work.moneyUnknownDetail', 'The source did not report this figure today.')
            : undefined
        }
      >
        {money.kind === 'value' ? formatMoney(money.value, { signed }) : unknownLabel(money)}
      </div>
    </div>
  )
}

function scorecardProblem(error: unknown): string {
  if (error instanceof CompaniesRequestError) {
    if (error.detail.status === 403) {
      return translate(
        'work.scorecardForbidden',
        'Company finance is limited to your access: {{detail}}',
        {
          detail: companiesErrorMessage(error)
        }
      )
    }
    if (error.detail.status === 404) {
      return translate('work.scorecardNotCollected', 'No scorecard has been collected yet.')
    }
  }
  return translate('work.scorecardUnavailable', 'Company finance is unavailable: {{detail}}', {
    detail: companiesErrorMessage(error)
  })
}

/**
 * How the companies are doing: today's money per company from the scorecard,
 * the scorecard's health judgement, and the estate totals when the reader may
 * see them. Every read names its own failure instead of blanking the section.
 */
export function WorkCompaniesSection({ revision }: { revision: number }): React.JSX.Element {
  const scorecard = useCompaniesRead(() => companiesApi().scorecard(), `scorecard:${revision}`)
  const health = useCompaniesRead(() => companiesApi().health({}), `health:${revision}`)
  const access = useCompanyAccess()
  // Why: the scorecard names companies by slug while a grant may name ids; the org tree maps them.
  const org = useCompaniesRead(() => companiesApi().org(), `org:${revision}`)
  const idBySlug = useMemo(
    () => new Map((org.data?.companies ?? []).map((company) => [company.slug, company.id])),
    [org.data]
  )
  const openCompaniesPage = useAppStore((state) => state.openCompaniesPage)
  // Why: the relay prunes the document; this only keeps a company the reader cannot act on off the home.
  // Why: the home shows the companies the folder tree shows — the ones work is filed under.
  const folderSet = useCompanyFolderSet()
  const rows = useMemo(
    () =>
      access.loading || folderSet.loading
        ? []
        : (scorecard.data ? companyMoneyRows(scorecard.data) : []).filter(
            (row) =>
              access.allows(row.slug, idBySlug.get(row.slug)) &&
              folderSet.has(row.slug, idBySlug.get(row.slug))
          ),
    [scorecard.data, access, folderSet, idBySlug]
  )
  const portfolio = scorecard.data ? portfolioToday(scorecard.data) : null
  const healthBySlug = new Map((health.data?.companies ?? []).map((row) => [row.slug, row]))
  const age = scorecard.data ? scorecardAgeMinutes(scorecard.data, new Date()) : null
  const signIn = needsOmniosSignIn(scorecard.error)
  return (
    <section
      aria-label={translate('work.companies', 'Companies')}
      data-work-companies={rows.length}
    >
      <WorkSectionTitle
        title={translate('work.companies', 'Companies')}
        sub={
          age !== null
            ? translate('work.scorecardAge', 'today · updated {{minutes}} min ago', {
                minutes: age
              })
            : undefined
        }
        action={
          <Button size="xs" variant="ghost" onClick={() => openCompaniesPage()}>
            {translate('work.allCompanies', 'All companies')}
          </Button>
        }
      />
      {signIn ? <CompaniesNotice error={scorecard.error} onRetry={scorecard.reload} /> : null}
      {scorecard.error && !signIn ? (
        <p
          role="status"
          className="mb-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
        >
          {scorecardProblem(scorecard.error)}
        </p>
      ) : null}
      {(scorecard.loading && !scorecard.data) || access.loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {translate('work.loadingCompanies', 'Loading company figures…')}
        </p>
      ) : null}
      {portfolio ? (
        <div
          className="mb-3 grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-4"
          data-work-portfolio=""
        >
          {MONEY_FIELDS.map((field) => (
            <MoneyFigure
              key={field}
              label={`${translate('work.estate', 'Estate')} · ${fieldLabel(field)}`}
              money={portfolio[field]}
              signed={field === 'pnl'}
              large
            />
          ))}
        </div>
      ) : scorecard.data?.scope?.totals_omitted ? (
        <p className="mb-2 text-[11px] text-muted-foreground">
          {translate('work.totalsOmitted', 'Estate totals are not shown for your access.')}
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {rows.map((row) => {
          const judgement = healthBySlug.get(row.slug) ?? null
          return (
            <li key={row.slug} data-work-company={row.slug}>
              <button
                type="button"
                // Why: Companies keys its rows by the org id; the detail read must be asked the same way.
                onClick={() => openCompaniesPage({ companyId: idBySlug.get(row.slug) ?? row.slug })}
                className="flex w-full flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/40"
              >
                {/* Why: the same mark the sidebar tree and the console use for this company. */}
                <CompanyMark
                  company={row.slug}
                  name={row.name}
                  className="size-4 shrink-0 rounded"
                  decorative
                />
                <div className="flex min-w-32 items-center gap-2">
                  <span className="truncate text-sm font-semibold">{row.name}</span>
                  <HealthBadge status={judgement?.status ?? 'unknown'} />
                </div>
                <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
                  {MONEY_FIELDS.map((field) => (
                    <MoneyFigure
                      key={field}
                      label={fieldLabel(field)}
                      money={row.today[field]}
                      signed={field === 'pnl'}
                    />
                  ))}
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          )
        })}
      </ul>
      {health.error && !needsOmniosSignIn(health.error) ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {translate('work.healthUnavailable', 'Company health is unavailable right now.')}
        </p>
      ) : null}
      {companyAccessSummary(access) ? (
        <p className="mt-1 text-[11px] text-muted-foreground" data-work-access="">
          {companyAccessSummary(access)}
        </p>
      ) : null}
    </section>
  )
}
