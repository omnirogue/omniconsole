import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type { BrowserLoginsApi } from '../../../../shared/browser-logins-contract'

// The browser client has no signed desktop session to open a live view with, so
// the browser-login rail is answered as unavailable rather than left to throw.
const unavailable = () =>
  Promise.resolve({
    ok: false as const,
    error: {
      code: 'capability_unavailable',
      message: translate(
        'browserLogins.desktopOnly',
        'Browser logins are available in the OmniConsole desktop app.'
      )
    }
  })

export function createWebBrowserLoginsApi(): Pick<PreloadApi, 'consoleBrowserLogins'> {
  const browserLogins = {
    list: unavailable,
    status: unavailable,
    open: unavailable,
    save: unavailable,
    verify: unavailable,
    add: unavailable,
    verifyAll: unavailable
  } as unknown as BrowserLoginsApi
  return { consoleBrowserLogins: browserLogins }
}
