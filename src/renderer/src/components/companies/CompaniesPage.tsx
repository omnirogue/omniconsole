import { useCallback, useEffect, useMemo, useState } from 'react'
import { Building2, ChevronRight, RefreshCw } from 'lucide-react'
import { CompanyMark } from './CompanyMark'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  isAccountingCompany,
  type AccountingCompany,
  type AccountingSnapshot
} from '../../../../shared/console-accounting-contract'
import type { OrgCompany, RollupCompany } from '../../../../shared/console-companies-contract'
import type { CompanyHealth } from '../../../../shared/console-company-health-contract'
import { CompaniesNotice, Figure, HealthBadge, SectionTitle } from './CompaniesNotice'
import { CompanyDetail } from './CompanyDetail'
import { ProviderBillsPanel } from './ProviderBillsPanel'
import {
  companiesApi,
  companiesErrorMessage,
  needsOmniosSignIn,
  useCompaniesRead
} from './companies-client'
import { companyAccessSummary, useCompanyAccess, useCompanyFolderSet } from './company-access'
import { accountTotals, money } from './company-model'

/**
 * The rows to show: every available company of the org tree, enriched with the
 * rollup's work counts when the rollup answered; a rollup-only company (not in the
 * org tree) still shows. Keyed by slug, then id.
 */
export function mergeCompanyRows(
  orgCompanies: readonly OrgCompany[],
  rollupRows: readonly RollupCompany[]
): RollupCompany[] {
  const bySlug = new Map<string, RollupCompany>()
  const keyOf = (row: { slug?: string | null; company_id?: string | null; id?: string | null }) =>
    row.slug ?? row.company_id ?? row.id ?? ''
  for (const row of rollupRows) {
    bySlug.set(keyOf(row), row)
  }
  const merged: RollupCompany[] = []
  const seen = new Set<string>()
  for (const company of orgCompanies) {
    if (company.available === false) {
      continue
    }
    const key = keyOf(company)
    const counts = bySlug.get(key) ?? bySlug.get(company.id ?? '') ?? null
    merged.push({
      company_id: company.id ?? counts?.company_id ?? null,
      slug: company.slug ?? counts?.slug ?? null,
      name: company.name ?? counts?.name ?? null,
      status: counts?.status ?? null,
      total: counts?.total ?? null,
      active: counts?.active ?? null,
      queued: counts?.queued ?? null,
      recent: counts?.recent ?? null,
      failed: counts?.failed ?? null,
      completed: counts?.completed ?? null,
      running: counts?.running ?? null
    })
    seen.add(key)
    if (company.id) {
      seen.add(company.id)
    }
  }
  for (const row of rollupRows) {
    if (!seen.has(keyOf(row)) && !seen.has(row.company_id ?? '')) {
      merged.push(row)
    }
  }
  return merged
}

function companyKey(company: RollupCompany): string {
  return company.company_id ?? company.slug ?? company.name ?? ''
}

function companyName(company: RollupCompany): string {
  return company.name ?? company.slug ?? company.company_id ?? 'Company'
}

/** Cash on hand, per currency, exactly as the accounting page totals it. */
function CashSummary({ snapshot }: { snapshot: AccountingSnapshot | null }) {
  const totals = snapshot ? accountTotals(snapshot.bank.accounts, 'cash_available_minor') : []
  if (!snapshot) {
    return <Figure label={translate('companies.availableCash', 'Available cash')} value={null} />
  }
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">
        {translate('companies.availableCash', 'Available cash')}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">
        {totals.length > 0
          ? totals.map((total) => money(total.amount, total.currency)).join(' · ')
          : translate('companies.unavailable', 'Unavailable')}
      </div>
    </div>
  )
}

function CompanyRow({
  company,
  health,
  accounting,
  missionCount,
  onOpen
}: {
  company: RollupCompany
  health: CompanyHealth | null
  accounting: AccountingSnapshot | null
  missionCount: number | null
  onOpen: () => void
}) {
  const counts = health?.domain_summary
  return (
    <button
      type="button"
      onClick={onOpen}
      data-company-row={companyKey(company)}
      className="flex w-full items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/40"
    >
      {/* Why: a company is recognised by its own mark, never a generic building. */}
      <CompanyMark
        company={company.slug ?? companyKey(company)}
        name={companyName(company)}
        className="mt-0.5 size-5 shrink-0 rounded-md"
        decorative
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold">{companyName(company)}</span>
          <HealthBadge status={health?.status ?? 'unknown'} />
        </div>
        <p className="text-xs text-muted-foreground">
          {health?.summary ??
            translate('companies.noHealth', 'No health measurements within your access.')}
        </p>
        <div className="grid grid-cols-2 gap-3 pt-1 sm:grid-cols-4">
          <Figure
            label={translate('companies.activeWork', 'Active work')}
            value={company.active ?? null}
          />
          <Figure
            label={translate('companies.blockedWork', 'Failed')}
            value={company.failed ?? null}
          />
          <Figure label={translate('companies.missions', 'Missions')} value={missionCount} />
          <CashSummary snapshot={accounting} />
        </div>
        {counts ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'companies.domainCounts',
              '{{healthy}} healthy · {{attention}} need attention · {{incomplete}} incomplete',
              {
                healthy: counts.healthy,
                attention: counts.attention,
                incomplete: counts.unknown + counts.unconfigured
              }
            )}
          </p>
        ) : null}
      </div>
      <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  )
}

function CompaniesList({ onOpen }: { onOpen: (companyId: string) => void }) {
  const access = useCompanyAccess()
  const folderSet = useCompanyFolderSet()
  // Why: the org tree is the list of companies; the rollup only adds work counts
  // and the hub refuses it to the console's machine principal, so it must never
  // decide whether a company appears.
  const org = useCompaniesRead(() => companiesApi().org(), 'org')
  const rollup = useCompaniesRead(() => companiesApi().rollup(), 'rollup')
  const health = useCompaniesRead(() => companiesApi().health({}), 'health:all')
  const missions = useCompaniesRead(() => companiesApi().missions(), 'missions')
  const omnirogue = useCompaniesRead(
    () => companiesApi().accounting({ company: 'omnirogue' }),
    'accounting:omnirogue'
  )
  const acme = useCompaniesRead(
    () => companiesApi().accounting({ company: 'acme' }),
    'accounting:acme'
  )
  // Why: the scorecard's `provider_bills` is estate-wide; the relay drops it for a
  // company-scoped reader, and then the panel below simply does not draw.
  const scorecard = useCompaniesRead(() => companiesApi().scorecard(), 'scorecard')
  const books = useMemo(
    () =>
      new Map<AccountingCompany, AccountingSnapshot | null>([
        ['omnirogue', omnirogue.data],
        ['acme', acme.data]
      ]),
    [omnirogue.data, acme.data]
  )
  const reload = useCallback(() => {
    org.reload()
    rollup.reload()
    health.reload()
    missions.reload()
    omnirogue.reload()
    acme.reload()
    scorecard.reload()
  }, [org, rollup, health, missions, omnirogue, acme, scorecard])
  // Why: a missing omnios session is one problem, not two; and with neither list
  // answered there is nothing to show but the reason.
  const signInError = [org.error, rollup.error].find((error) => needsOmniosSignIn(error))
  if (signInError) {
    return <CompaniesNotice error={signInError} onRetry={reload} />
  }
  if (org.error && !org.data && (rollup.error || !rollup.data)) {
    return <CompaniesNotice error={org.error} onRetry={reload} />
  }
  // Why: the console already prunes its reads; this only keeps a row the reader
  // cannot act on from being offered here.
  // Why: the page shows the companies the folder tree shows — the ones work is filed
  // under — not every record the org tree carries.
  const companies =
    access.loading || folderSet.loading
      ? []
      : mergeCompanyRows(org.data?.companies ?? [], rollup.data?.companies ?? []).filter(
          (company) =>
            access.allows(company.company_id, company.slug) &&
            folderSet.has(company.company_id, company.slug)
        )
  const loading =
    access.loading ||
    folderSet.loading ||
    (org.loading && !org.data) ||
    (rollup.loading && !rollup.data)
  const healthRows = health.data?.companies ?? []
  const missionRows = missions.data?.missions.items ?? []
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <SectionTitle
          title={translate('companies.yourCompanies', 'Companies')}
          sub={
            folderSet.known
              ? translate('companies.folderScope', 'the {{count}} with work filed', {
                  count: companies.length
                })
              : rollup.data?.window_hours
                ? translate('companies.window', 'last {{hours}}h of work', {
                    hours: rollup.data.window_hours
                  })
                : undefined
          }
        />
        <p role="status" className="text-xs text-muted-foreground">
          {companyAccessSummary(access)}
        </p>
        {health.error && !needsOmniosSignIn(health.error) ? (
          <p role="status" className="text-xs text-muted-foreground">
            {translate('companies.healthUnavailable', 'Company health is unavailable right now.')}
          </p>
        ) : null}
        {rollup.error && !needsOmniosSignIn(rollup.error) ? (
          <p role="status" className="text-xs text-muted-foreground">
            {translate('companies.rollupUnavailable', 'Work counts are unavailable: {{detail}}', {
              detail: companiesErrorMessage(rollup.error)
            })}
          </p>
        ) : null}
        {loading && companies.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {translate('companies.loading', 'Loading companies…')}
          </p>
        ) : null}
        {!loading && companies.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            {translate(
              'companies.noCompanies',
              'The estate returned no companies for this account.'
            )}
          </p>
        ) : null}
        {companies.map((company) => {
          const slug = company.slug ?? company.company_id ?? ''
          const id = companyKey(company)
          return (
            <CompanyRow
              key={id}
              company={company}
              health={healthRows.find((row) => row.slug === slug) ?? null}
              accounting={isAccountingCompany(slug) ? (books.get(slug) ?? null) : null}
              missionCount={
                missions.data
                  ? missionRows.filter((mission) => mission.company_id === id).length
                  : null
              }
              onOpen={() => onOpen(id)}
            />
          )
        })}
        <ProviderBillsPanel scorecard={scorecard.data} />
        <div className="pt-2">
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="size-3.5" />
            {translate('companies.refresh', 'Refresh')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'companies.footnote',
            'Read-only from omnios. Cash is bank availability, not revenue; revenue and profit come from each company’s books.'
          )}
        </p>
      </div>
    </div>
  )
}

/** Sal's birds-eye view: every company the estate knows, then one company in full. */
export default function CompaniesPage() {
  const account = useAppStore((state) => state.activeOrcaProfileId)
  const environment = useAppStore(
    (state) =>
      `${state.settings?.backofficeEnv}:${state.settings?.backofficeLocalUrl}:${state.settings?.backofficeProductionUrl}`
  )
  // Why: the Work home opens one company directly; the request is consumed once on mount.
  const requested = useAppStore((state) => state.companiesPageCompanyId)
  const [selected, setSelected] = useState<string | null>(requested)
  useEffect(() => {
    if (requested) {
      setSelected(requested)
      useAppStore.setState({ companiesPageCompanyId: null })
    }
  }, [requested])
  return (
    <div
      key={`${account}:${environment}`}
      data-testid="companies-page"
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <header className="flex flex-wrap items-center justify-between gap-4 border-b px-6 py-5">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <Building2 className="size-5" />
            {translate('companies.nav', 'Companies')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {translate(
              'companies.subtitle',
              'Every company in the estate — health, work and money, read from omnios.'
            )}
          </p>
        </div>
        {selected ? (
          <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
            {translate('companies.backToAll', 'All companies')}
          </Button>
        ) : null}
      </header>
      {selected ? (
        <CompanyDetail key={selected} companyId={selected} />
      ) : (
        <CompaniesList onOpen={setSelected} />
      )}
    </div>
  )
}
