import { companySlug } from '../../../shared/company-identity'
import type { WorkFolderCompany } from '../../../shared/console-work-folders-contract'

/**
 * "Company › Department" for a task card's own filing (`company_slug` + `org_unit_id`),
 * the same lookup `buildCompanyTaskTree` uses to place a card under its department.
 * Null when the company is not in the loaded folder tree, or the card names none.
 */
export function taskCardCompanyPlace(
  companies: readonly WorkFolderCompany[],
  cardCompanySlug: string | null | undefined,
  orgUnitId: string | null | undefined
): string | null {
  const slug = companySlug(cardCompanySlug ?? '')
  if (!slug) {
    return null
  }
  const company = companies.find(
    (candidate) => companySlug(candidate.slug ?? candidate.name ?? candidate.id ?? '') === slug
  )
  if (!company) {
    return null
  }
  const domainName = orgUnitId
    ? (company.domains.find((domain) => domain.id === orgUnitId)?.name ?? '').trim()
    : ''
  return [company.name ?? slug, domainName || undefined].filter(Boolean).join(' › ')
}
