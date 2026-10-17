import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type { ConsoleQuickBooksApi } from '../../../../shared/console-quickbooks-contract'

// No signed desktop session in the browser, so the connection answers "unavailable"
// rather than rendering as "not connected" — which would be a claim about the books.
export function createWebConsoleQuickBooksApi(): Pick<PreloadApi, 'consoleQuickBooks'> {
  const quickBooks = {
    status: () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: 'capability_unavailable',
          message: translate(
            'quickbooks.desktopOnly',
            'The books connection is available in the OmniConsole desktop app.'
          )
        }
      })
  } as unknown as ConsoleQuickBooksApi
  return { consoleQuickBooks: quickBooks }
}
