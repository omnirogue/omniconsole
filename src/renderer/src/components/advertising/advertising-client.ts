import { translate } from '@/i18n/i18n'
import { CompaniesRequestError, useCompaniesRead } from '@/components/companies/companies-client'
import type { ConsoleAdvertisingApi } from '../../../../shared/console-advertising-contract'

/**
 * The renderer's door to the signed advertising reads. It holds no credential and
 * no URL: the main process owns both, and this file can only name an operation.
 */
export function advertisingApi(): ConsoleAdvertisingApi {
  const api = window.api?.consoleAdvertising
  if (!api) {
    throw new CompaniesRequestError({
      code: 'capability_unavailable',
      message: translate(
        'advertising.apiUnavailable',
        'Advertising needs an updated OmniConsole desktop app.'
      )
    })
  }
  return api
}

export { useCompaniesRead as useAdvertisingRead, CompaniesRequestError as AdvertisingRequestError }
