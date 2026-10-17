import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type { ConsoleAdvertisingApi } from '../../../../shared/console-advertising-contract'

// The browser client holds no signed desktop session, so every advertising read
// answers "unavailable" rather than throwing or, worse, painting an empty report
// that would read as a day with no spend.
const unavailable = () =>
  Promise.resolve({
    ok: false as const,
    error: {
      code: 'capability_unavailable',
      message: translate(
        'advertising.desktopOnly',
        'Advertising is available in the OmniConsole desktop app.'
      )
    }
  })

export function createWebConsoleAdvertisingApi(): Pick<PreloadApi, 'consoleAdvertising'> {
  const advertising = {
    salesAds: unavailable,
    dailySales: unavailable,
    webinar: unavailable,
    adOps: unavailable,
    decision: unavailable
  } as unknown as ConsoleAdvertisingApi
  return { consoleAdvertising: advertising }
}
