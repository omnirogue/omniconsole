import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'
import type { ConsoleAccessApi } from '../../../../shared/console-access-contract'

// The browser client has no signed desktop session to read omnios with, so the
// Tool Shelf is answered as unavailable rather than left to throw.
const unavailable = () =>
  Promise.resolve({
    ok: false as const,
    error: {
      code: 'capability_unavailable',
      message: translate(
        'toolShelf.desktopOnly',
        'The Tool Shelf is available in the OmniConsole desktop app.'
      )
    }
  })

export function createWebConsoleAccessApi(): Pick<PreloadApi, 'consoleAccess'> {
  const access = {
    mine: unavailable,
    people: unavailable,
    person: unavailable,
    change: unavailable,
    sections: unavailable,
    bulk: unavailable
  } as unknown as ConsoleAccessApi
  return { consoleAccess: access }
}
