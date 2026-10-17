import React from 'react'
import { Badge } from '@/components/ui/badge'
import { useCompaniesRead } from '@/components/companies/companies-client'
import { translate } from '@/i18n/i18n'
import {
  connectionLabel,
  isFeedEnabled,
  reasonLabel,
  type QboCompany
} from '../../../../shared/console-quickbooks-contract'
import { isAccountingCompany } from '../../../../shared/console-accounting-contract'

/**
 * The books connection: which companies are wired to QuickBooks and what each is waiting
 * on.
 *
 * Read-only by design. Authorizing a company is an OAuth consent only a person can give
 * in a browser, and choosing its ledger accounts changes what the books report — so this
 * surface shows state and names the next step in words, rather than offering a button
 * that would need its own review to exist.
 *
 * The distinction that matters: "the connection could not be read" is not "the books are
 * not connected". One is this app's problem and the other is a fact about the company's
 * accounting, and a reader must never be shown the first as the second.
 */
function ConnectionRow({ company }: { company: QboCompany }): React.JSX.Element {
  const enabled = isFeedEnabled(company)
  const name = company.mapped_company_name ?? company.company_name ?? company.company_slug
  return (
    <li
      className="space-y-0.5 border-t py-1.5 first:border-t-0"
      data-qbo-company={company.company_slug}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium">{name}</span>
        <Badge variant={enabled ? 'secondary' : 'outline'} className="shrink-0 text-[10px]">
          {connectionLabel(company.status)}
        </Badge>
      </div>
      {/* A connected feed needs no next step; everything else gets one in words. */}
      {enabled ? null : (
        <p className="text-[11px] text-muted-foreground">{reasonLabel(company.reason_code)}</p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {company.checked_at
          ? translate('quickbooks.checked', 'Last checked {{when}}', {
              when: company.checked_at.slice(0, 16).replace('T', ' ')
            })
          : translate('quickbooks.neverChecked', 'Never checked.')}
        {company.realm_id
          ? ` · ${translate('quickbooks.realm', 'realm {{realm}}', { realm: company.realm_id })}`
          : ''}
        {company.mappings.length > 0
          ? ` · ${translate('quickbooks.mapped', '{{count}} ledger accounts mapped', {
              count: company.mappings.length
            })}`
          : ` · ${translate('quickbooks.unmapped', 'no ledger accounts mapped')}`}
      </p>
    </li>
  )
}

export function QuickBooksPanel({
  slug,
  revision
}: {
  slug: string
  revision: number
}): React.JSX.Element | null {
  // An older desktop has no such namespace; that is not a fact about the books.
  const api = window.api?.consoleQuickBooks ?? null
  const available = api !== null
  const read = useCompaniesRead(() => api!.status(), `quickbooks:${revision}`, available)
  // The companies whose books this console tracks at all.
  const rows = (read.data?.companies ?? []).filter(
    (company) => !isAccountingCompany(slug) || company.company_slug === slug
  )
  const missing = read.data?.oauth.missing_requirements ?? []
  return (
    <div className="space-y-2 border-t pt-3" data-quickbooks="">
      <h4 className="text-xs font-medium">
        {translate('quickbooks.title', 'QuickBooks')}
        <span className="ml-1.5 font-normal text-muted-foreground">
          {translate('quickbooks.sub', 'where revenue and profit come from')}
        </span>
      </h4>
      {!available ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'quickbooks.needsDesktop',
            'The books connection needs an updated OmniConsole desktop app.'
          )}
        </p>
      ) : read.loading ? (
        <p className="text-[11px] text-muted-foreground">
          {translate('quickbooks.loading', 'Reading the books connection…')}
        </p>
      ) : read.error ? (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          {/* Not "not connected": this says the read failed, which is a different fact. */}
          {translate(
            'quickbooks.unreadable',
            'The books connection could not be read, so its state is unknown.'
          )}
        </p>
      ) : (
        <>
          {read.data?.oauth.configured === false ? (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              {translate(
                'quickbooks.appNotConfigured',
                'The QuickBooks app connection is not configured yet, so no company can be authorized.'
              )}
              {missing.length > 0
                ? ` ${translate('quickbooks.missing', 'Still needed: {{list}}.', {
                    list: missing.join(', ')
                  })}`
                : ''}
            </p>
          ) : null}
          {rows.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'quickbooks.noCompanies',
                'No QuickBooks company is tracked for this company.'
              )}
            </p>
          ) : (
            <ul>
              {rows.map((company) => (
                <ConnectionRow key={company.company_slug} company={company} />
              ))}
            </ul>
          )}
          {read.data?.sync_health ? (
            <p className="text-[11px] text-muted-foreground">
              {translate('quickbooks.syncHealth', 'Sync health: {{state}}.', {
                state: read.data.sync_health
              })}
            </p>
          ) : null}
        </>
      )}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'quickbooks.readOnly',
          'This view reads only. Authorizing a company, choosing its ledger accounts and re-checking a connection stay in OmniOS.'
        )}
      </p>
    </div>
  )
}
