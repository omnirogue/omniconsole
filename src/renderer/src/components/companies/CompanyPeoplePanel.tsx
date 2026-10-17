import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import { CompaniesNotice, SectionTitle } from './CompaniesNotice'
import { companiesApi, useCompaniesRead } from './companies-client'
import { useCompanyAccess } from './company-access'

function PersonLine({ person, lead }: { person: OrgChartPerson; lead?: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="font-medium">{person.name}</span>
      {person.title ? <span className="text-muted-foreground">· {person.title}</span> : null}
      {person.email ? (
        <span className="font-mono text-[11px] text-muted-foreground">· {person.email}</span>
      ) : null}
      {lead ? (
        <span className="text-[11px] uppercase text-muted-foreground">
          {translate('companies.peopleLead', 'lead')}
        </span>
      ) : null}
    </li>
  )
}

/** The estate's employee org chart, read under the company that owns it. */
export function CompanyPeoplePanel(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Why: the org chart is estate-wide; a reader scoped to some companies is not offered it here.
  const access = useCompanyAccess()
  const estateWide = !access.loading && access.scope === 'all'
  const chart = useCompaniesRead(() => companiesApi().orgChart(), 'orgChart', open && estateWide)
  const people = new Map((chart.data?.people ?? []).map((person) => [person.id, person]))
  const units = chart.data?.units ?? []
  const placed = new Set<string>()
  for (const unit of units) {
    if (unit.lead_person_id) {
      placed.add(unit.lead_person_id)
    }
    for (const id of unit.member_ids) {
      placed.add(id)
    }
  }
  const everyoneElse = [...people.values()].filter((person) => !placed.has(person.id))
  return (
    <section className="space-y-2" data-testid="company-people">
      <SectionTitle title={translate('companies.people', 'People')} />
      <Button size="xs" variant="outline" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {open
          ? translate('companies.peopleHide', 'Hide the org chart')
          : translate('companies.peopleShow', 'Show the org chart')}
      </Button>
      {!open ? null : !estateWide ? (
        // Why: the chart is estate-wide; a reader whose scope is not known to be the estate gets a sentence.
        <p className="text-xs text-muted-foreground">
          {access.loading
            ? translate('companies.loading', 'Loading companies…')
            : access.scope === 'unknown'
              ? translate(
                  'companies.accessUnknown',
                  'Your access could not be read; showing everything.'
                )
              : translate(
                  'companies.peopleScoped',
                  'The people chart covers the whole estate; it is shown to estate-wide access only.'
                )}
        </p>
      ) : chart.error ? (
        <CompaniesNotice error={chart.error} onRetry={chart.reload} />
      ) : chart.loading && !chart.data ? (
        <p className="text-xs text-muted-foreground">
          {translate('companies.peopleLoading', 'Loading the org chart…')}
        </p>
      ) : (
        <div className="space-y-4 rounded-lg border p-3">
          {units.map((unit) => {
            const lead = unit.lead_person_id ? people.get(unit.lead_person_id) : undefined
            const members = unit.member_ids
              .map((id) => people.get(id))
              .filter((person): person is OrgChartPerson => Boolean(person))
            return (
              <div key={unit.id} className="space-y-1">
                <h3 className="text-sm font-semibold">{unit.name}</h3>
                <ul className="space-y-0.5">
                  {lead ? <PersonLine key={lead.id} person={lead} lead /> : null}
                  {members.map((person) => (
                    <PersonLine key={person.id} person={person} />
                  ))}
                </ul>
                {!lead && members.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {translate('companies.peopleEmptyUnit', 'No one is listed here yet.')}
                  </p>
                ) : null}
              </div>
            )
          })}
          {everyoneElse.length > 0 ? (
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">
                {translate('companies.peopleUnassigned', 'Everyone else')}
              </h3>
              <ul className="space-y-0.5">
                {everyoneElse.map((person) => (
                  <PersonLine key={person.id} person={person} />
                ))}
              </ul>
            </div>
          ) : null}
          {units.length === 0 && everyoneElse.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate('companies.peopleEmpty', 'The estate returned no people.')}
            </p>
          ) : null}
        </div>
      )}
    </section>
  )
}
