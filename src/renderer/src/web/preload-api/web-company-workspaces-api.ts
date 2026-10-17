import { translate } from '@/i18n/i18n'
import type { PreloadApi } from '../../../../preload/api-types'

// The browser client has no filesystem of its own, so it answers where it cannot
// act rather than pretending a folder was created.
export function createWebCompanyWorkspacesApi(): Pick<PreloadApi, 'companyWorkspaces'> {
  return {
    companyWorkspaces: {
      home: () => Promise.resolve(''),
      ensureFolder: () =>
        Promise.resolve({
          ok: false as const,
          message: translate(
            'companyFolders.desktopOnly',
            'Company folders can only be created in the OmniConsole desktop app.'
          )
        })
    }
  }
}
