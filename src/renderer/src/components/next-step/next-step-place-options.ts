import type { CompanyPlace } from '@/lib/company-place'
import { sessionPlaceKey, type SessionPlaceChoice } from '@/lib/session-place-choice'
import type { WorkFolderCompany } from '../../../../shared/console-work-folders-contract'

export type NextStepPlaceOption = { value: string; label: string; choice: SessionPlaceChoice }

/**
 * Every company → department pair the console files under, in tree order. A row without an
 * id cannot be filed by the hub, so it is not offered.
 */
export function nextStepPlaceOptions(
  companies: readonly WorkFolderCompany[]
): NextStepPlaceOption[] {
  const options: NextStepPlaceOption[] = []
  for (const company of companies) {
    if (!company.id) {
      continue
    }
    const companyName = (company.name ?? company.slug ?? company.id).trim() || company.id
    for (const domain of company.domains) {
      if (!domain.id) {
        continue
      }
      const unitName = (domain.name ?? domain.id).trim() || domain.id
      const choice = { companyId: company.id, unitId: domain.id, companyName, unitName }
      options.push({
        value: sessionPlaceKey(choice),
        label: nextStepPlaceLabel(choice),
        choice
      })
    }
  }
  return options
}

export function nextStepPlaceLabel(place: Pick<SessionPlaceChoice, 'companyName' | 'unitName'>): string {
  return `${place.companyName} → ${place.unitName}`
}

/** The folder's own place as a choice, when it names a department; the company root does not. */
export function placeChoiceFromCompanyPlace(
  place: CompanyPlace | null | undefined
): SessionPlaceChoice | null {
  if (!place?.company.id || !place.domain?.id) {
    return null
  }
  return {
    companyId: place.company.id,
    unitId: place.domain.id,
    companyName: place.company.name,
    unitName: place.domain.name
  }
}
