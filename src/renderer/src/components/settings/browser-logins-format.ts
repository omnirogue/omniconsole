import { translate } from '@/i18n/i18n'
import {
  CompaniesRequestError,
  companiesErrorMessage,
  needsOmniosSignIn
} from '@/components/companies/companies-client'
import type { BrowserLoginsApi } from '../../../../shared/browser-logins-contract'

/** The desktop's browser-login rail transport, or a clear refusal when it is missing. */
export function browserLoginsApi(): BrowserLoginsApi {
  const api = window.api?.consoleBrowserLogins
  if (!api) {
    throw new CompaniesRequestError({
      code: 'capability_unavailable',
      message: translate(
        'browserLogins.apiUnavailable',
        'Browser logins need an updated OmniConsole desktop app.'
      )
    })
  }
  return api
}

export function browserLoginsErrorLine(error: unknown): string {
  if (needsOmniosSignIn(error)) {
    return translate(
      'browserLogins.signIn',
      'Sign in to OmniConsole (Backoffice above) to see browser logins.'
    )
  }
  return companiesErrorMessage(error)
}

/** The host a profile's site URL points at, or the raw text when it will not parse. */
export function siteHost(url: string | null | undefined): string {
  if (!url) {
    return ''
  }
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export type BrowserLoginStatusTone = 'good' | 'attention' | 'bad' | 'neutral'

/** Badge tone for a login status, kept lenient — an unrecognized status reads as neutral. */
export function browserLoginStatusTone(loginStatus: string): BrowserLoginStatusTone {
  if (loginStatus === 'verified') {
    return 'good'
  }
  if (loginStatus === 'error') {
    return 'bad'
  }
  if (loginStatus === 'sign_in_required' || loginStatus === 'not_verified') {
    return 'attention'
  }
  return 'neutral'
}

/** The status label shown in the table; a translated word for the statuses the rail knows. */
export function browserLoginStatusLabel(loginStatus: string): string {
  switch (loginStatus) {
    case 'verified':
      return translate('browserLogins.status.verified', 'Signed in')
    case 'sign_in_required':
      return translate('browserLogins.status.signInRequired', 'Needs re-login')
    case 'error':
      return translate('browserLogins.status.error', 'Error')
    case 'not_checked':
      return translate('browserLogins.status.notChecked', 'Not checked yet')
    case 'not_verified':
      return translate('browserLogins.status.notVerified', 'Not verified')
    default:
      return loginStatus
  }
}
