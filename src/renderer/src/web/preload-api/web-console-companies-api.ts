import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type { ConsoleCompaniesApi } from '../../../../shared/console-companies-contract'

// The browser client has no signed desktop session to read omnios with, so the
// companies view is answered as unavailable rather than left to throw.
const unavailable = () =>
  Promise.resolve({
    ok: false as const,
    error: {
      code: 'capability_unavailable',
      message: translate(
        'companies.desktopOnly',
        'Companies are available in the OmniConsole desktop app.'
      )
    }
  })

export function createWebConsoleCompaniesApi(): Pick<PreloadApi, 'consoleCompanies'> {
  const companies = {
    rollup: unavailable,
    scorecard: unavailable,
    me: unavailable,
    orgChart: unavailable,
    missions: unavailable,
    today: unavailable,
    org: unavailable,
    company: unavailable,
    health: unavailable,
    accounting: unavailable,
    syncAccounting: unavailable,
    transactionsCsv: unavailable
  } as unknown as ConsoleCompaniesApi
  return { consoleCompanies: companies }
}
