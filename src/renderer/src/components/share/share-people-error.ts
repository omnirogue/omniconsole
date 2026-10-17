import { translate } from '@/i18n/i18n'
import { CompaniesRequestError } from '@/components/companies/companies-client'

export function sharePeopleError(error: unknown): string {
  if (error instanceof CompaniesRequestError) {
    const { code, message } = error.detail
    if (code === 'routine_owner_required') {
      return translate('sharePeople.ownerRequired', 'Only the owner can share this routine.')
    }
    if (/company|department|task.*permission|task.*access/.test(code)) {
      return translate(
        'sharePeople.accessRequired',
        "This person doesn't have access to this company or department."
      )
    }
    return translate('sharePeople.failedDetail', 'Unable to add this person: {{message}}', {
      message
    })
  }
  return translate('sharePeople.failed', 'Unable to add this person. Refresh and try again.')
}
