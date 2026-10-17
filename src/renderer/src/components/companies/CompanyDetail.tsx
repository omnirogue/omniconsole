import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { isAccountingCompany } from '../../../../shared/console-accounting-contract'
import { hasCompanyHealth } from '../../../../shared/console-company-health-contract'
import { CompaniesNotice, SectionTitle } from './CompaniesNotice'
import { CompanyPeoplePanel } from './CompanyPeoplePanel'
import { CompanyStartSession } from './CompanyStartSession'
import { useCompanyAccess } from './company-access'
import { CompanyAccountingPanel } from './CompanyAccountingPanel'
import { CompanyCockpit } from './CompanyCockpit'
import { CompanyHealthPanel } from './CompanyHealthPanel'
import { companiesApi, useCompaniesRead } from './companies-client'
import { keyedByContent } from './company-model'

function Goals({
  goals,
  available,
  reason,
  domainName
}: {
  goals: {
    id?: string | null
    title?: string | null
    status?: string | null
    horizon?: string | null
    owner_employee_id?: string | null
  }[]
  available: boolean
  reason?: string | null
  domainName?: string
}) {
  if (!available) {
    return (
      <p className="text-xs text-muted-foreground">
        {reason ?? translate('companies.goalsUnavailable', 'The goals feed is unavailable.')}
      </p>
    )
  }
  if (goals.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {domainName
          ? translate('companies.noDomainGoals', 'No goals are tagged to this department yet.')
          : translate('companies.noGoals', 'No goals recorded for this company.')}
      </p>
    )
  }
  return (
    <div className="divide-y rounded-lg border">
      {keyedByContent(
        goals,
        (goal) => goal.id ?? `${goal.title ?? ''}:${goal.horizon ?? ''}:${goal.status ?? ''}`
      ).map(({ key, item: goal }) => (
        <div key={key} data-testid="company-goal" className="flex items-baseline gap-3 px-3 py-2">
          <Badge variant={goal.status === 'active' ? 'secondary' : 'outline'} className="shrink-0">
            {goal.status ?? '—'}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={goal.title ?? ''}>
            {goal.title}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {goal.horizon ?? ''}
            {goal.owner_employee_id ? ` · ${goal.owner_employee_id}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * One company: its departments, its goals, the hub's cockpit, the scorecard's
 * judgement and — where the company keeps books — its money. Read-only, the same
 * sections and the same numbers as the omnios company page.
 */
export function CompanyDetail({ companyId }: { companyId: string }) {
  const [domain, setDomain] = useState<string | null>(null)
  const company = useCompaniesRead(
    () => companiesApi().company({ companyId }),
    `company:${companyId}`
  )
  const org = useCompaniesRead(() => companiesApi().org(), 'org')
  const orgCompany = org.data?.companies.find(
    (row) => row.id === companyId || row.slug === companyId
  )
  const slug = orgCompany?.slug ?? companyId
  const selectedDomain = domain ? orgCompany?.domains.find((row) => row.id === domain) : undefined
  const access = useCompanyAccess()
  const allGoals = company.data?.goals.items ?? []
  // Department deep-link: goals carry org_unit_id matching the domain ids.
  const goals = domain ? allGoals.filter((goal) => goal.org_unit_id === domain) : allGoals
  const name = orgCompany?.name ?? companyId
  const inScope = access.allows(companyId, orgCompany?.slug, orgCompany?.id)
  // Why: a denial needs both the scope and the company's keys; until then, say loading.
  if (access.loading || (org.loading && !org.data)) {
    return (
      <p role="status" className="m-6 text-sm text-muted-foreground">
        {translate('companies.loading', 'Loading companies…')}
      </p>
    )
  }
  if (!inScope) {
    return (
      <p role="status" className="m-6 text-sm text-muted-foreground">
        {translate('companies.accessDenied', 'This company is outside your access.')}
      </p>
    )
  }
  if (company.error) {
    return <CompaniesNotice error={company.error} onRetry={company.reload} />
  }
  return (
    <div data-testid="company-page" className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{name}</h2>
            <CompanyStartSession
              company={{ slug, name }}
              domain={selectedDomain ? { id: domain, name: selectedDomain.name ?? '' } : null}
              size="sm"
            />
          </div>
          <p className="text-sm text-muted-foreground">
            {translate(
              'companies.detailIntro',
              'The estate’s view of this company — goals, cockpit, health and money. Read-only from the hub.'
            )}
          </p>
        </div>

        {orgCompany && orgCompany.domains.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {orgCompany.domains.map((row) => (
              <span key={row.id ?? row.name} className="inline-flex items-center gap-1">
                <Button
                  size="xs"
                  variant={row.id === domain ? 'default' : 'outline'}
                  title={row.workstreams.join(', ')}
                  onClick={() => setDomain(row.id === domain ? null : (row.id ?? null))}
                >
                  {row.name} ({row.workstreams.length})
                </Button>
                <CompanyStartSession
                  company={{ slug, name }}
                  domain={{ id: row.id, name: row.name ?? '' }}
                  label={translate('companySessions.startHere', 'Start')}
                />
              </span>
            ))}
          </div>
        ) : null}
        {selectedDomain ? (
          <p className="text-xs text-muted-foreground">
            <b>{selectedDomain.name}</b> {translate('companies.workstreams', 'workstreams')}:{' '}
            {selectedDomain.workstreams.join(', ') || '—'}
          </p>
        ) : null}

        <section className="space-y-2">
          <SectionTitle
            title={translate('companies.goals', 'Company goals')}
            sub={translate('companies.goalCount', '{{count}} goals', { count: goals.length })}
          />
          {company.loading && !company.data ? (
            <p className="text-xs text-muted-foreground">
              {translate('companies.loading', 'Loading companies…')}
            </p>
          ) : (
            <Goals
              goals={goals}
              available={company.data?.goals.available ?? false}
              reason={company.data?.goals.reason}
              domainName={selectedDomain?.name ?? undefined}
            />
          )}
        </section>

        <section className="space-y-2">
          <SectionTitle
            title={translate('companies.cockpit', 'Workgraph cockpit')}
            sub={translate('companies.cockpitSub', 'what the hub sees here')}
          />
          {!company.data ? (
            <p className="text-xs text-muted-foreground">
              {translate('companies.loading', 'Loading companies…')}
            </p>
          ) : !company.data.cockpit.available ? (
            <p className="text-xs text-muted-foreground">
              {company.data.cockpit.reason ??
                translate('companies.cockpitUnavailable', 'The cockpit feed is unavailable.')}
            </p>
          ) : company.data.cockpit.value ? (
            <CompanyCockpit value={company.data.cockpit.value} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {translate(
                'companies.cockpitEmpty',
                'The hub sent an empty cockpit — unknown, not none.'
              )}
            </p>
          )}
        </section>

        {hasCompanyHealth(slug) ? (
          <section className="space-y-2">
            <SectionTitle title={translate('companies.health', 'Company health')} />
            <CompanyHealthPanel slug={slug} domainId={domain ?? undefined} />
          </section>
        ) : null}

        {isAccountingCompany(slug) ? <CompanyAccountingPanel company={slug} /> : null}

        <CompanyPeoplePanel />
      </div>
    </div>
  )
}
