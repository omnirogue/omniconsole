import { translate } from '@/i18n/i18n'
import type {
  WorkFolderCompany,
  WorkFolderDomain
} from '../../../../shared/console-work-folders-contract'

export const EMPTY_COMPANIES: readonly WorkFolderCompany[] = []
const EMPTY_DOMAINS: readonly WorkFolderDomain[] = []

/** The company/domain a row is filed under, resolved from the folder tree by slug/id. */
export function rowPlace(
  row: { todo?: { company_slug?: string | null; org_unit_id?: string | null } },
  companyBySlug: Map<string, WorkFolderCompany>
): { company?: WorkFolderCompany; domain?: WorkFolderDomain } {
  const company = row.todo?.company_slug ? companyBySlug.get(row.todo.company_slug) : undefined
  const domain = company?.domains.find((entry) => entry.id === row.todo?.org_unit_id)
  return { company, domain }
}

/** Narrow the picker to one company, then to one of that company's domains. */
export function AttachTaskFilters({
  companies,
  companySlug,
  domainId,
  selectedCompany,
  onCompanyChange,
  onDomainChange
}: {
  companies: readonly WorkFolderCompany[]
  companySlug: string
  domainId: string
  selectedCompany: WorkFolderCompany | undefined
  onCompanyChange: (slug: string) => void
  onDomainChange: (id: string) => void
}): React.JSX.Element {
  const domainOptions = selectedCompany?.domains ?? EMPTY_DOMAINS
  return (
    <div className="flex gap-2">
      <select
        aria-label={translate('tasks.filterCompanyLabel', 'Company')}
        value={companySlug}
        onChange={(event) => onCompanyChange(event.target.value)}
        className="rounded-md border border-input bg-background p-1 text-xs"
      >
        <option value="">{translate('tasks.filterCompanyAll', 'All companies')}</option>
        {companies.map((company) => (
          <option key={company.id ?? company.slug ?? company.name} value={company.slug ?? ''}>
            {company.name ?? company.slug}
          </option>
        ))}
      </select>
      <select
        aria-label={translate('tasks.filterDomainLabel', 'Domain')}
        value={domainId}
        onChange={(event) => onDomainChange(event.target.value)}
        disabled={!selectedCompany}
        className="rounded-md border border-input bg-background p-1 text-xs disabled:opacity-50"
      >
        <option value="">{translate('tasks.filterDomainAll', 'All domains')}</option>
        {domainOptions.map((domain) => (
          <option key={domain.id ?? domain.name} value={domain.id ?? ''}>
            {domain.name ?? domain.id}
          </option>
        ))}
      </select>
    </div>
  )
}
