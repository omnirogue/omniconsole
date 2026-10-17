import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  companiesApi,
  needsOmniosSignIn,
  useCompaniesRead
} from '@/components/companies/companies-client'
import { CompanyMark } from '@/components/companies/CompanyMark'
import { isAccountingCompany } from '../../../../shared/console-accounting-contract'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { FinanceStatsSection, OperationsStatsSection } from './CompanyStatsSections'
import { ServiceStatsSection } from './ServiceStatsSection'
import { FinancialTrend } from './FinancialTrend'
import { financialHistory } from './financial-history'
import { coverageNotes, SCORECARD_STALE_MINUTES } from './stats-model'
import { WorkSectionTitle } from './WorkSectionTitle'
import { scorecardAgeMinutes } from './work-model'

/** The books' connection, read from the same accounting snapshot the panel uses. */
function useBooksNote(slug: string, revision: number): string | null {
  const company = isAccountingCompany(slug) ? slug : null
  const read = useCompaniesRead(
    () => companiesApi().accounting({ company: company ?? 'omnirogue' }),
    `books:${slug}:${revision}`,
    company !== null
  )
  if (company === null) {
    return null
  }
  if (read.error) {
    return translate('work.booksUnavailable', 'The books connection could not be read.')
  }
  const books = read.data?.books
  if (!books) {
    return null
  }
  const status =
    books.status === 'ready'
      ? translate('work.booksReady', 'connected')
      : books.status === 'not_connected'
        ? translate('work.booksNotConnected', 'not connected')
        : translate('work.booksError', 'needs attention')
  return translate(
    'work.booksLine',
    'QuickBooks: {{status}}{{name}}{{synced}}. Bank activity includes transfers; revenue and profit come from the books.',
    {
      status,
      name: books.company_name ? ` · ${books.company_name}` : '',
      synced: books.last_synced_at
        ? ` · ${translate('work.booksSynced', 'last synced {{when}}', {
            when: books.last_synced_at.slice(0, 16).replace('T', ' ')
          })}`
        : ''
    }
  )
}

/**
 * The performance stats Sal reads to improve the business: the seven-day money
 * trend across every company, then one company at a time through finance and
 * admin, operations, and customer service.
 *
 * It all comes from one read — the collector's scorecard — so a figure here and a
 * figure on the Advertising view can disagree only about their window, never about
 * their source. When the document is older than its staleness budget the whole
 * section says so once, at the top, rather than letting each figure look current.
 */
export function WorkStatsSection({ revision }: { revision: number }): React.JSX.Element | null {
  const scorecard = useCompaniesRead(() => companiesApi().scorecard(), `scorecard:${revision}`)
  const openAdvertisingPage = useAppStore((state) => state.openAdvertisingPage)
  const document = scorecard.data
  const companies = document?.companies ?? []
  const [slug, setSlug] = useState<string | null>(null)
  const selected = companies.find((company) => company.slug === slug) ?? companies[0] ?? null
  const history = useMemo(() => financialHistory(document), [document])
  const notes = useMemo(() => coverageNotes(document), [document])
  const age = document ? scorecardAgeMinutes(document, new Date()) : null
  const booksNote = useBooksNote(selected?.slug ?? '', revision)

  // Why: signing in is the Companies section's message to give; this one stays quiet.
  if (needsOmniosSignIn(scorecard.error)) {
    return null
  }
  if (scorecard.error) {
    return (
      <section aria-label={translate('work.performance', 'Performance')}>
        <WorkSectionTitle title={translate('work.performance', 'Performance')} />
        <p
          role="status"
          className="rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground"
        >
          {translate(
            'work.statsUnavailable',
            'Performance figures are unavailable right now. Nothing was changed.'
          )}
        </p>
      </section>
    )
  }
  if (!document) {
    return (
      <section aria-label={translate('work.performance', 'Performance')}>
        <WorkSectionTitle title={translate('work.performance', 'Performance')} />
        <p role="status" className="text-sm text-muted-foreground">
          {translate('work.loadingStats', 'Loading performance figures…')}
        </p>
      </section>
    )
  }
  const stale = age !== null && age > SCORECARD_STALE_MINUTES
  return (
    <section
      aria-label={translate('work.performance', 'Performance')}
      data-work-stats={companies.length}
      className="space-y-3"
    >
      <WorkSectionTitle
        title={translate('work.performance', 'Performance')}
        sub={
          age === null
            ? undefined
            : translate('work.statsAge', 'collected {{minutes}} min ago · {{zone}}', {
                minutes: age,
                zone: document.timezone ?? translate('work.zoneUnknown', 'timezone unknown')
              })
        }
        action={
          <Button size="xs" variant="ghost" onClick={openAdvertisingPage}>
            {translate('work.openAdvertising', 'Advertising')}
          </Button>
        }
      />
      {stale ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
        >
          {translate(
            'work.statsStale',
            'These figures were collected {{minutes}} minutes ago, past the {{budget}}-minute freshness budget. They describe a state of the world that may have moved on.',
            { minutes: age ?? 0, budget: SCORECARD_STALE_MINUTES }
          )}
        </p>
      ) : null}
      <div className="rounded-xl border bg-card p-4">
        <FinancialTrend history={history} />
      </div>
      {companies.length > 1 ? (
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label={translate('work.pickCompany', 'Pick a company')}
        >
          {companies.map((company) => (
            <button
              key={company.slug}
              type="button"
              aria-pressed={company.slug === selected?.slug}
              onClick={() => setSlug(company.slug)}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
                company.slug === selected?.slug ? 'bg-accent font-medium' : 'text-muted-foreground'
              }`}
            >
              <CompanyMark
                company={company.slug}
                name={company.name ?? company.slug}
                className="size-3.5 shrink-0 rounded"
                decorative
              />
              {company.name ?? company.slug}
            </button>
          ))}
        </div>
      ) : null}
      {selected ? (
        <div className="space-y-3" data-work-stats-company={selected.slug}>
          <FinanceStatsSection
            company={selected}
            finance={document.finance?.[selected.slug]}
            booksNote={booksNote}
            slug={selected.slug}
            revision={revision}
          />
          <OperationsStatsSection
            operations={document.operations?.[selected.slug]}
            document={document}
            slug={selected.slug}
          />
          <ServiceStatsSection service={document.customer_service?.[selected.slug]} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate('work.noCompaniesInScope', 'No company figures are in your access.')}
        </p>
      )}
      {notes.length > 0 ? (
        <details className="rounded-lg border bg-card px-3 py-2 text-[11px]">
          <summary className="cursor-pointer font-medium">
            {translate('work.coverageGaps', 'Data coverage · {{count}} gaps', {
              count: notes.length
            })}
          </summary>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {notes.map((note) => (
              <li key={`${note.scope}:${note.detail}`}>
                <span className="font-medium">{note.scope}</span> — {note.detail}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
